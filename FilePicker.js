import {
  chakra,
  Box,
  Button,
  Center,
  Icon,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Stack,
  Text,
  Flex,
  Grid
} from '@chakra-ui/react'
import { useEffect, useState, useRef, isValidElement } from 'react'
import { useTranslation } from 'react-i18next'
import { VscFiles, VscFolderOpened } from 'react-icons/vsc'
import Debug from 'debug'
import dragDrop from 'drag-drop'

import { captureException } from '../lib/sentry.js'

import { useBrowser } from '../hooks/useBrowser.js'
import { useBreakpointValue } from '../hooks/useBreakpointValue.js'

const debug = Debug('wormhole:FilePicker')

export const FilePicker = ({ onFiles = () => {}, description, ...rest }) => {
  const { t } = useTranslation()
  const isDesktopBreakpoint = useBreakpointValue([false, false, true])
  const [isDragHover, setIsDragHover] = useState(false)
  const elem = useRef(null)

  const { fileInput, showFilePicker, showDirectoryPicker } = useFileInput(
    onFiles
  )

  const { isMobile, device } = useBrowser()

  const drag = !isMobile || device === 'ipad'

  // Support drag and drop
  useEffect(() => {
    if (!drag) return

    const cleanupElem = dragDrop(elem.current, {
      onDrop: files => onFiles(files),
      onDragEnter: () => setIsDragHover(true),
      onDragLeave: () => setIsDragHover(false)
    })

    // To improve UX, also allow drops anywhere on the page
    const cleanupBody = dragDrop(document.body, onFiles)

    return () => {
      cleanupElem()
      cleanupBody()
    }
  }, [drag, onFiles])

  // Support pasting from clipboard
  useEffect(() => {
    const handlePaste = event => {
      const items = event.clipboardData.items
      dragDrop.processItems(items, (err, files) => {
        if (err) {
          captureException(err)
          return
        }
        if (files.length > 0) {
          onFiles(files)
        }
      })
    }
    document.addEventListener('paste', handlePaste)

    return () => {
      document.removeEventListener('paste', handlePaste)
    }
  }, [onFiles])

  // Prevent clicks within <AddFilesButton> from propagating to our onClick
  // handler and triggering an extra call to showFilePicker
  const stopPropagation = event => event.stopPropagation()

  return (
    <Box
      borderStyle={drag && 'dashed'}
      borderColor={drag && 'whiteAlpha.800'}
      borderWidth={drag && 2}
      borderRadius='2xl'
      h={drag ? ['2xs', 'xs', 'sm'] : ['auto', null, 'full']}
      backgroundColor={isDragHover && 'whiteAlpha.500'}
      ref={elem}
      onClick={drag ? showFilePicker : () => {}}
      flexDirection='column'
      cursor='default'
      {...rest}
    >
      <Grid w='full' h='full'>
        <Center gridColumn={1} gridRow={1}>
          <Stack spacing={4} align='center'>
            <Box onClick={stopPropagation}>
              <AddFilesButton
                fileInput={fileInput}
                showFilePicker={showFilePicker}
                showDirectoryPicker={showDirectoryPicker}
                onFiles={onFiles}
              />
            </Box>
            {drag && <Box>{t('filePicker.orDragStuffHere')}</Box>}
          </Stack>
        </Center>
        {description != null && (
          <Flex
            direction='column'
            justify='flex-end'
            align='center'
            gridColumn={1}
            gridRow={drag || isDesktopBreakpoint ? 1 : 2}
          >
            {isValidElement(description) ? (
              description
            ) : (
              <Text pb={drag ? 4 : 0} textAlign='center' color='whiteAlpha.500'>
                {description}
              </Text>
            )}
          </Flex>
        )}
      </Grid>
    </Box>
  )
}

const AddFilesButton = ({
  fileInput,
  showFilePicker,
  showDirectoryPicker,
  onFiles = () => {}
}) => {
  const { t } = useTranslation()
  const [isMobile, setIsMobile] = useState(true)
  const browser = useBrowser()

  // Use client value for `isMobile`, since server value is different for iPad
  useEffect(() => {
    setIsMobile(browser.isMobile)
  }, [browser])

  const buttonSize = useBreakpointValue(['md', 'lg'])

  if (isMobile) {
    // iOS and Android don't allow directory selection
    return (
      <Button size={buttonSize} onClick={showFilePicker}>
        {fileInput}
        {t('filePicker.selectFilesToSend')}
      </Button>
    )
  }

  return (
    <Menu>
      {fileInput}
      <MenuButton as={Button} size={buttonSize}>
        {t('filePicker.selectFilesToSend')}
      </MenuButton>
      <MenuList>
        <MenuItem
          icon={<Icon as={VscFiles} boxSize={5} />}
          onClick={showFilePicker}
        >
          {t('filePicker.selectFiles')}
        </MenuItem>
        <MenuItem
          icon={<Icon as={VscFolderOpened} boxSize={5} />}
          onClick={showDirectoryPicker}
        >
          {t('filePicker.selectAFolder')}
        </MenuItem>
      </MenuList>
    </Menu>
  )
}

const useFileInput = (onFiles = () => {}) => {
  const inputElem = useRef(null)

  const handleChange = event => {
    const files = Array.from(event.target.files)
    if (files.length > 0) {
      onFiles(files)
    }
  }

  const fileInput = (
    <chakra.input
      type='file'
      display='none'
      onChange={handleChange}
      ref={inputElem}
    />
  )

  const showFilePicker = () => {
    debug('showFilePicker')
    inputElem.current.multiple = true
    inputElem.current.webkitdirectory = false
    inputElem.current.click()
  }

  const showDirectoryPicker = () => {
    debug('showDirectoryPicker')
    inputElem.current.multiple = false
    inputElem.current.webkitdirectory = true
    inputElem.current.click()
  }

  return {
    fileInput,
    showFilePicker,
    showDirectoryPicker
  }
}
