import { basename } from 'path'
import { EventEmitter } from 'events'
import { isJunkPath } from 'create-torrent'
import Debug from 'debug'
import parseRange from 'range-parser'
import prettyBytes from 'pretty-bytes'
import reemit from 're-emitter'
import throttle from 'throttleit'
import { Keychain, transformStream } from 'wormhole-crypto'

import { roundSizeAsMb, logEvent } from './analytics.js'
import { setEventContext } from './event-context.js'
import { browserDetect } from './browser-detect.js'
import { makeStreamSource } from './service-worker-download.js'
import { fetcher } from './fetcher.js'
import { EncryptedTorrent } from './encrypted-torrent.js'
import { WormholeError } from './errors.js'
import { makeZipStream } from './make-zip-stream.js'
import { captureException } from './sentry.js'
import { getMediaType } from '../lib/media-type.js'
import { addOrReplaceRoom } from '../lib/RoomStorage.js'

import {
  b2Config,
  maxRoomSize,
  origin,
  uploaderPingIntervalSeconds
} from '../config.js'

// Poll remainingDownloads interval
const REMAINING_DOWNLOADS_POLL_INTERVAL_SECS = 120

// Security headers – See server/util.js for an explanation
const DOWNLOAD_SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'geolocation=(), camera=(), microphone=(), sync-xhr=(), interest-cohort=()',
  'Document-Policy': 'document-write=?0',
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none';"
}

const debug = Debug('wormhole:Room')

export class Room extends EventEmitter {
  // inactive, active
  peerState = 'inactive'
  // not-started, uploading, uploaded, upload-failed
  cloudState = 'not-started'

  destroyed = false
  id = null
  files = null
  downloadStreamSource = null
  downloadUrls = null
  zipDownloadUrl = null
  meta = null

  // internal
  encryptedTorrent = null
  keychain = null
  torrent = null
  handleCreateProgress = null
  pollRemainingDownloadsInterval = null
  pollUploaderPingInterval = null

  downloadProgress = new Map()

  constructor () {
    super()
    debug('constructor')
  }

  get url () {
    return this.id ? `${origin}/${this.id}#${this.keychain.keyB64}` : null
  }

  async create (uploadFiles) {
    if (this.destroyed) {
      throw new Error('Already destroyed')
    }

    this.keychain = new Keychain()

    const processedFiles = processFiles(uploadFiles)

    if (processedFiles.length === 0) {
      throw new WormholeError('ZERO_FILES', 'Please choose a non-empty folder')
    }

    let size = 0
    for (const file of processedFiles) size += file.length

    if (size > maxRoomSize) {
      // TODO: localize this!
      throw new WormholeError(
        'ROOM_MAX_ROOM_SIZE',
        `These files are ${prettyBytes(
          size
        )}. The maximum size is ${prettyBytes(maxRoomSize)}.`
      )
    }

    // While torrent is being created, set files to the plaintext
    this.emit('files', processedFiles)

    // Create room on server
    const room = await fetcher.post('/api/room', {
      body: {
        readerToken: await this.keychain.authTokenB64(),
        salt: this.keychain.saltB64
      },
      retry: true
    })

    if (this.destroyed) return

    const {
      id,
      writerToken,
      expiresAtTimestampMs,
      maxDownloads,
      lifetime,
      remainingDownloads
    } = room

    this.meta = {
      id,
      expiresAtTimestampMs,
      lifetime,
      maxDownloads,
      numDownloadingPeers: 0,
      remainingDownloads
    }
    this.emit('meta', this.meta)

    setEventContext('roomId', id)
    this.id = id
    this.emit('url', this.url)

    this.keychain.setAuthToken(writerToken)

    // Start ping before encrypting
    this._pollUploaderPing()

    this.encryptedTorrent = new EncryptedTorrent(this.keychain, {
      bucketName: b2Config.bucketName,
      pathPrefix: b2Config.pathPrefix,
      name: id,
      authUpload: async numTokens =>
        await fetcher.post(`/api/room/${id}/b2/auth-upload`, {
          body: {
            numTokens
          },
          headers: {
            Authorization: await this.keychain.authHeader()
          },
          retry: true
        })
    })
    this._cleanupListeners = reemit(this.encryptedTorrent, this, ['error'])
    this._listenCreateProgress()

    // Create torrent
    const torrentInfo = await this.encryptedTorrent.createTorrent(
      processedFiles,
      id,
      expiresAtTimestampMs
    )

    if (this.destroyed) return

    // If this.destroyed is true, torrentInfo will be nullish
    const { infoHash, encryptedTorrentFile, torrent } = torrentInfo

    this.torrent = torrent
    this._addTorrentListeners()
    this._initServiceWorkerDownloads()

    this.emit('files', this._files)

    // Add torrent file to room config
    await fetcher.patch(`/api/room/${id}`, {
      body: {
        infoHash,
        encryptedTorrentFile: Buffer.from(encryptedTorrentFile).toString(
          'base64'
        ),
        multiFile: processedFiles.length > 1,
        sizeMb: roundSizeAsMb(size)
      },
      headers: {
        Authorization: await this.keychain.authHeader()
      },
      retry: true
    })

    if (this.destroyed) return

    // Retry announce now that the tracker allows the infoHash
    torrent.discovery.tracker.update()

    this.peerState = 'active'
    this.emit('peerState', 'active')
    this._listenCreateProgress() // Reset for upload progress
    this._pollRemainingDownloads()

    let success = true
    if (this.encryptedTorrent.cloudSize > room.maxCloudSize) {
      success = false
      console.error('Too big for cloud upload; skipping!')
    } else {
      this.cloudState = 'uploading'
      this.emit('cloudState', this.cloudState)
      try {
        await this.encryptedTorrent.cloudUpload()
      } catch (err) {
        success = false
        console.error('Cloud upload failed!', err)
      }
    }

    if (this.destroyed) return

    try {
      await fetcher.post(`/api/room/${id}/b2/finish-upload`, {
        body: {
          success
        },
        headers: {
          Authorization: await this.keychain.authHeader()
        },
        retry: true
      })
    } catch (err) {
      success = false
      console.error('Failed to notify server of upload completion!', err)
    }

    if (this.destroyed) return

    this.cloudState = success ? 'uploaded' : 'upload-failed'
    this.emit('cloudState', this.cloudState)

    if (success) {
      clearInterval(this.pollUploaderPingInterval)
      this.pollUploaderPingInterval = null
    }

    // Save in local DB
    try {
      const generateTitle = files => {
        let str = files[0].name
        for (let i = 1; i < files.length; i++) {
          const f = files[i]
          if (str.length + f.name.length > 50) {
            str += ', ...'
            break
          }
          str += `, ${f.name}`
        }
        return str
      }

      await addOrReplaceRoom({
        id,
        title: generateTitle(processedFiles),
        size: processedFiles.reduce((acc, f) => acc + f.length, 0),
        key: this.keychain.keyB64,
        writerToken,
        lifetime,
        remainingDownloads,
        expiresAtTimestampMs,
        files: processedFiles.map(f => ({
          name: f.name,
          length: f.length
        }))
      })
    } catch (err) {
      console.error('Room not saved in local DB', err)
    }
  }

  async join (id, key) {
    if (this.destroyed) {
      throw new Error('Already destroyed')
    }

    if (key == null) {
      throw new WormholeError('SECRET_KEY_INVALID', 'The secret key is missing')
    }

    setEventContext('roomId', id)

    this.id = id

    let roomLoaded = false

    const { salt } = await fetcher.get(`/api/room/${id}/salt`, {
      retry: true
    })

    if (this.destroyed) return

    try {
      this.keychain = new Keychain(key, salt)
    } catch (err) {
      throw new WormholeError('SECRET_KEY_INVALID', 'The secret key is invalid')
    }
    this.encryptedTorrent = new EncryptedTorrent(this.keychain, {
      bucketName: b2Config.bucketName,
      pathPrefix: b2Config.pathPrefix,
      name: id,
      authDownload: async () =>
        fetcher.post(`/api/room/${id}/b2/auth-download`, {
          headers: {
            Authorization: await this.keychain.authHeader()
          },
          retry: true
        })
    })
    this._cleanupListeners = reemit(this.encryptedTorrent, this, ['error'])

    this.emit('url', this.url)

    // eslint-disable-next-line no-unmodified-loop-condition
    while (true) {
      if (this.destroyed) return

      let room
      try {
        room = await fetcher.get(`/api/room/${id}`, {
          headers: {
            Authorization: await this.keychain.authHeader()
          },
          retry: true
        })
      } catch (err) {
        if (err.res?.status === 403) {
          throw new WormholeError(
            'SECRET_KEY_INVALID',
            'The secret key is invalid'
          )
        }
        throw err
      }

      if (this.destroyed) return

      const {
        cloudState,
        encryptedTorrentFile,
        expiresAtTimestampMs,
        lifetime,
        maxDownloads,
        remainingDownloads
      } = room

      if (cloudState !== this.cloudState) {
        this.cloudState = cloudState
        this.emit('cloudState', this.cloudState)
      }

      if (!roomLoaded) {
        roomLoaded = true
        this.meta = {
          id,
          expiresAtTimestampMs,
          lifetime,
          maxDownloads,
          numDownloadingPeers: 0,
          remainingDownloads
        }
        this.emit('meta', this.meta)
      }

      if (encryptedTorrentFile) {
        const torrentInfo = await this.encryptedTorrent.loadTorrent(
          Buffer.from(encryptedTorrentFile, 'base64'),
          id,
          expiresAtTimestampMs,
          this._waitForUpload.bind(this)
        )

        if (this.destroyed) return

        // If this.destroyed is true, torrentInfo will be nullish
        this.torrent = torrentInfo.torrent

        this._addTorrentListeners()
        this._initServiceWorkerDownloads()

        this.emit('files', this._files)

        this.peerState = 'active'
        this.emit('peerState', this.peerState)

        break
      }

      // Poll every 5 seconds if the torrent file isn't available
      await new Promise(resolve => {
        setTimeout(resolve, 5000)
      })
    }

    this._pollRemainingDownloads()
  }

  async _waitForUpload () {
    while (true) {
      if (this.destroyed) return false

      if (this.cloudState === 'uploaded') {
        return true
      } else if (this.cloudState === 'upload-failed') {
        return false
      }

      // Poll every 5 seconds if the cloud download isn't ready
      await new Promise(resolve => {
        setTimeout(resolve, 5000)
      })

      if (this.destroyed) return false

      try {
        const { cloudState } = await fetcher.get(
          `/api/room/${this.id}/cloud-state`,
          {
            headers: {
              Authorization: await this.keychain.authHeader()
            },
            retry: true
          }
        )
        this.cloudState = cloudState
      } catch (err) {
        captureException(err)

        const status = err.res?.status
        if (status >= 400 && status <= 499) {
          // API error; don't retry
          this.cloudState = 'upload-failed'
        }
      }
    }
  }

  _pollRemainingDownloads () {
    if (this.pollRemainingDownloadsInterval) {
      return
    }

    this.pollRemainingDownloadsInterval = setInterval(async () => {
      const { remainingDownloads } = await fetcher.get(
        `/api/room/${this.id}/remaining-downloads`,
        {
          headers: {
            Authorization: await this.keychain.authHeader()
          },
          retry: true
        }
      )

      if (this.destroyed) return

      if (remainingDownloads !== this.meta.remainingDownloads) {
        this.meta.remainingDownloads = remainingDownloads
        debug(`remainingDownloads changed to ${this.meta.remainingDownloads}`)
        this.emit('meta', { ...this.meta })
      }

      if (remainingDownloads === 0) {
        clearInterval(this.pollRemainingDownloadsInterval)
        this.pollRemainingDownloadsInterval = null
      }
    }, REMAINING_DOWNLOADS_POLL_INTERVAL_SECS * 1000)
  }

  _pollUploaderPing () {
    if (this.pollUploaderPingInterval) {
      return
    }

    const callUploaderPing = async () => {
      await fetcher.patch(`/api/room/${this.id}/uploader-online`, {
        headers: {
          Authorization: await this.keychain.authHeader()
        },
        retry: true
      })
    }

    this.pollUploaderPingInterval = setInterval(
      callUploaderPing,
      uploaderPingIntervalSeconds * 1000
    )

    // Trigger first time immediately
    callUploaderPing()
  }

  get _files () {
    return (
      this.encryptedTorrent?.files?.map(file => {
        const { path } = file
        let progress = 0

        const downloadProgress = this.downloadProgress.get(path)?.[0].progress
        if (downloadProgress !== undefined) {
          // Show 0.1% progress immediately when download requested
          progress = Math.max(downloadProgress, 0.001)
        }

        const getPreviewUrl = () => this._getPreviewUrl(file)
        const getDownloadUrl = () => this._getDownloadUrl(file)

        return {
          ...file,
          progress,
          getPreviewUrl,
          getDownloadUrl
        }
      }) || null
    )
  }

  _initializeFileProgress (file) {
    const { path, length } = file
    // Use an object so it has a stable identity
    const progressEntry = {
      progress: 0
    }

    let progressEntries = this.downloadProgress.get(path)
    if (progressEntries === undefined) {
      progressEntries = [progressEntry]
      this.downloadProgress.set(path, progressEntries)
      if (this.downloadProgress.size === 1) {
        // A download started when none were in progress before
        this.emit('downloading', true)
      }
    } else {
      progressEntries.push(progressEntry)
    }

    return {
      onProgress: progress => {
        progressEntry.progress = progress / length
      },
      onDone: () => {
        const index = progressEntries.indexOf(progressEntry)
        if (index >= 0) {
          progressEntries.splice(index, 1)
          if (progressEntries.length === 0) {
            this.downloadProgress.delete(path)
            if (this.downloadProgress.size === 0) {
              // The last download finished
              this.emit('downloading', false)
            }
          }
        }
      }
    }
  }

  _trackStreamProgress (stream, onProgress, onDone) {
    let bytesDownloaded = 0
    const transform = transformStream(stream, {
      transform: async (chunk, controller) => {
        await controller.enqueue(chunk)

        if (onProgress) {
          bytesDownloaded += chunk.byteLength
          onProgress(bytesDownloaded)

          this._handleProgress()
        }
      }
    })

    if (onDone) {
      transform.done.then(onDone, onDone)
    }

    return transform.readable
  }

  _handleProgress = throttle(() => {
    if (this.downloadProgress.size > 0) {
      this.emit('files', this._files)
    }
  }, 500)

  async _initServiceWorkerDownloads () {
    const files = this.encryptedTorrent.files

    const downloadStreamSource = await makeStreamSource()
    if (downloadStreamSource == null) {
      return
    }
    if (this.destroyed) {
      downloadStreamSource.destroy()
      return
    }
    this.downloadStreamSource = downloadStreamSource

    this.downloadUrls = new Map()
    const urls = this.downloadStreamSource.addFiles(
      files.map(file => async ({ searchParams, headers }) => {
        const { preview } = searchParams

        return await this._getFileStream(file, {
          isDownload: !preview,
          requestHeaders: headers
        })
      })
    )

    for (const [index, file] of files.entries()) {
      this.downloadUrls.set(file.path, urls[index])
    }

    this.zipDownloadUrl = this.downloadStreamSource.addFile(async () => {
      return await this._getZipStream()
    })
  }

  async _getFileStream (file, opts = {}) {
    const { name, length: fileLength } = file
    const { isDownload, requestHeaders } = opts

    const headers = {
      'Content-Length': fileLength,
      'Accept-Ranges': 'bytes',
      ...DOWNLOAD_SECURITY_HEADERS
    }
    const contentType = getMediaType(name)
    if (contentType != null) {
      headers['Content-Type'] = contentType
    }

    let status = 200
    let statusText = 'OK'
    let decryptOpts
    let startsAtByteZero = true
    const rangeHeader = requestHeaders?.range
    if (rangeHeader !== undefined) {
      // Handle Range requests
      const ranges = parseRange(fileLength, rangeHeader)
      if (ranges.type === 'bytes') {
        const start = ranges[0].start
        const end = ranges[0].end // inclusive
        const length = end - start + 1

        startsAtByteZero = start === 0

        headers['Content-Length'] = length
        headers['Content-Range'] = `bytes ${start}-${end}/${fileLength}`

        status = 206
        statusText = 'Partial Content'
        decryptOpts = {
          offset: start,
          length
        }
      } else {
        return {
          response: {
            status: 416,
            statusText: 'Range Not Satisfiable',
            headers: {
              'Content-Range': `bytes */${fileLength}`
            }
          },
          stream: new globalThis.ReadableStream()
        }
      }
    }

    // Only log requests for the beginning of the file
    if (startsAtByteZero) {
      logEvent('download', {
        type: isDownload ? 'single' : 'preview'
      })
    }

    let stream = await this.encryptedTorrent.decryptFile(file, decryptOpts)
    if (this.destroyed) {
      stream.cancel().catch(() => {})
      return null
    }

    let idleTimeout
    if (isDownload) {
      const { onProgress, onDone } = this._initializeFileProgress(file)
      this.emit('files', this._files)
      stream = this._trackStreamProgress(stream, onProgress, () => {
        onDone()
        this.emit('files', this._files)
      })

      headers['Content-Disposition'] = encodeContentDisposition(name)
    } else {
      // Kill the preview stream after a minute. When testing with
      // Sintel.mp4 I observed up to 17 second idle periods with
      // Chrome but much less with Firefox/Safari
      idleTimeout = 60_000
    }

    return {
      response: {
        status,
        statusText,
        headers
      },
      stream,
      idleTimeout
    }
  }

  async _getZipStream () {
    const files = this.encryptedTorrent.files

    logEvent('download', { type: 'all' })

    const onDoneHandlers = []

    const zipContents = await Promise.all(
      files.map(async file => {
        let stream = await this.encryptedTorrent.decryptFile(file)
        const { onProgress, onDone } = this._initializeFileProgress(file)
        onDoneHandlers.push(onDone)

        stream = this._trackStreamProgress(stream, onProgress)

        return {
          stream,
          path: file.path
        }
      })
    )
    if (this.destroyed) {
      for (const { stream } of zipContents) {
        stream.cancel().catch(() => {})
      }
      return null
    }

    let stream = makeZipStream(zipContents)

    this.emit('files', this._files)
    const transform = transformStream(stream)

    const done = () => {
      for (const onDone of onDoneHandlers) {
        onDone()
      }
      this.emit('files', this._files)
    }
    transform.done.then(done, done)

    stream = transform.readable

    const name = `Wormhole ${this.id}.zip`

    return {
      stream,
      response: {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': encodeContentDisposition(name),
          ...DOWNLOAD_SECURITY_HEADERS
        }
      }
    }
  }

  async _getDownloadUrl (file) {
    if (this.destroyed) return null

    const { path } = file
    const { browser, os } = browserDetect()

    // service worker doesn't work for downloads on Safari
    if (browser !== 'safari' && os !== 'ios') {
      const url = this.downloadUrls?.get(path)
      if (url != null) {
        return url
      }
    }
    const streamResponse = await this._getFileStream(file, {
      isDownload: true
    })
    if (streamResponse == null) return null

    const { headers } = streamResponse.response
    // Video 'view' option fails on iOS
    if (os === 'ios' && headers?.['Content-Type']?.startsWith('video/')) {
      headers['Content-Type'] = 'application/octet-stream'
    }

    return await this._streamToBlobUrl(streamResponse)
  }

  async _getPreviewUrl (file) {
    if (this.destroyed) return null

    const { path } = file

    const url = this.downloadUrls?.get(path)
    if (url != null) {
      // Adding preview=1 disables the progress bar
      return `${url}?preview=1`
    }

    const streamResponse = await this._getFileStream(file, {
      isDownload: false
    })
    if (streamResponse == null) return null
    return await this._streamToBlobUrl(streamResponse)
  }

  async _streamToBlobUrl ({ stream, response }) {
    const res = new globalThis.Response(stream, response)

    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }

  async getZipUrl () {
    if (this.destroyed) return null

    const { browser, os } = browserDetect()

    // service worker doesn't work for downloads on Safari
    if (browser !== 'safari' && os !== 'ios') {
      const url = this.zipDownloadUrl
      if (url != null) {
        return url
      }
    }

    const streamResponse = await this._getZipStream()
    if (streamResponse == null) return null
    return await this._streamToBlobUrl(streamResponse)
  }

  async handleDelete () {
    if (this.destroyed) {
      throw new Error('Already destroyed')
    }

    await fetcher.delete(`/api/room/${this.id}`, {
      headers: {
        Authorization: await this.keychain.authHeader()
      },
      retry: true
    })
  }

  async handleReport (reason) {
    if (this.destroyed) {
      throw new Error('Already destroyed')
    }

    await fetcher.post(`/api/room/${this.id}/report`, {
      body: {
        reason
      },
      headers: {
        Authorization: await this.keychain.authHeader()
      },
      retry: true
    })
  }

  async handleRoomLifetimeChange (lifetime) {
    if (this.destroyed) {
      throw new Error('Already destroyed')
    }

    await fetcher.patch(`/api/room/${this.id}/expiration`, {
      body: {
        lifetime
      },
      headers: {
        Authorization: await this.keychain.authHeader()
      },
      retry: true
    })
  }

  async handleMaxRoomDownloadsChange (maxDownloads) {
    if (this.destroyed) {
      throw new Error('Already destroyed')
    }

    await fetcher.patch(`/api/room/${this.id}/expiration`, {
      body: {
        maxDownloads
      },
      headers: {
        Authorization: await this.keychain.authHeader()
      },
      retry: true
    })
  }

  _listenCreateProgress () {
    if (!this.encryptedTorrent) throw new Error('no encryptedTorrent')

    if (this.handleCreateProgress) {
      this.encryptedTorrent.off('createProgress', this.handleCreateProgress)
    }
    const handleCreateProgress = throttle(progress => {
      // Ensure throttled events don't go through if handleCreateProgress has been reset
      if (handleCreateProgress === this.handleCreateProgress) {
        this.emit('createProgress', Math.max(progress, 0.01))
      }
    }, 500)
    this.handleCreateProgress = handleCreateProgress

    this.emit('createProgress', 0.01)
    this.encryptedTorrent.on('createProgress', this.handleCreateProgress)
  }

  _addTorrentListeners () {
    if (!this.torrent) throw new Error('no torrent')
    this.torrent.on('warning', this._handleTorrentWarning)
    this.torrent.on('wire', this._handleTorrentWire)
  }

  _removeTorrentListeners () {
    if (!this.torrent) throw new Error('no torrent')
    this.torrent.off('warning', this._handleTorrentWarning)
    this.torrent.off('wire', this._handleTorrentWire)
  }

  _handleTorrentWarning = err => {
    debug(`torrent warning: ${err.message}`)
  }

  _handleTorrentWireInterested = () => {
    if (this.meta == null) return
    this.meta.numDownloadingPeers += 1
    debug(`numDownloadingPeers incremented to ${this.meta.numDownloadingPeers}`)
    this.emit('meta', { ...this.meta })
  }

  _handleTorrentWireUninterested = () => {
    if (this.meta == null) return
    this.meta.numDownloadingPeers -= 1
    debug(`numDownloadingPeers decremented to ${this.meta.numDownloadingPeers}`)
    this.emit('meta', { ...this.meta })
  }

  _handleTorrentWire = wire => {
    if (wire.type === 'webSeed') {
      return
    }

    wire.on('interested', this._handleTorrentWireInterested)
    wire.on('uninterested', this._handleTorrentWireUninterested)

    wire.once('close', () => {
      if (wire.peerInterested) {
        this._handleTorrentWireUninterested()
      }

      wire.off('interested', this._handleTorrentWireInterested)
      wire.off('uninterested', this._handleTorrentWireUninterested)
    })
  }

  async destroy () {
    if (this.destroyed) {
      throw new Error('Already destroyed')
    }
    this.destroyed = true

    if (this.torrent) {
      this._removeTorrentListeners()
      this.torrent = null
    }

    if (this._cleanupListeners) {
      this._cleanupListeners()
    }

    if (this.downloadStreamSource) {
      this.downloadStreamSource.destroy()
      this.downloadStreamSource = null
      this.downloadUrls = null
      this.zipDownloadUrl = null
    }

    clearInterval(this.pollRemainingDownloadsInterval)
    this.pollRemainingDownloadsInterval = null

    clearInterval(this.pollUploaderPingInterval)
    this.pollUploaderPingInterval = null

    if (this.encryptedTorrent) {
      if (this.handleCreateProgress) {
        this.encryptedTorrent.off('createProgress', this.handleCreateProgress)
      }
      this.encryptedTorrent.destroy()
      this.encryptedTorrent = null
    }

    this.peerState = null
    this.cloudState = null
    this.handleCreateProgress = null

    this.id = null
    this.downloadProgress.clear()
    this.meta = null
  }
}

function processFiles (files) {
  const ret = []
  for (const file of files) {
    // With drag and drop, fullPath is available.
    // When picking a drectory using <input> with webkitdirectory set, webkitRelativePath is available.
    // Otherwise, only name is available.
    const path = file.fullPath || file.webkitRelativePath || file.name

    // Skip junk files
    if (isJunkPath(path.split('/'))) continue

    const fileWrapper = {
      file,
      path,
      name: basename(path),
      length: file.size,
      progress: 0
    }
    ret.push(fileWrapper)
  }
  return ret
}

// eslint-disable-next-line no-control-regex
const ENCODE_URL_ATTR_CHAR_REGEXP = /[\x00-\x20"'()*,/:;<=>?@[\\\]{}\x7f]/g

// The syntax for filename is very weird; see
// https://datatracker.ietf.org/doc/html/rfc6266#section-4.3
function encodeContentDisposition (name) {
  // percent encode as UTF-8
  const encoded = encodeURIComponent(name).replace(
    ENCODE_URL_ATTR_CHAR_REGEXP,
    pencode
  )

  return `attachment; filename*=UTF-8''${encoded}`
}

function pencode (char) {
  return '%' + String(char).charCodeAt(0).toString(16).toUpperCase()
}
