const zip = new JSZip();

document.getElementById('filepicker').addEventListener(
  'change',
  async (event) => {
    let output = document.getElementById('listing');
    for (const file of event.target.files) {
      let item = document.createElement('li');
      item.textContent = removeZipRootFolder(file.webkitRelativePath);
      output.appendChild(item);
    }
    await Promise.all(
      [...event.target.files].map((file) => {
        return addFileToZip(file, removeZipRootFolder(file.webkitRelativePath));
      })
    ).then(() => {
      zip.generateAsync({ type: 'blob' }).then(function (content) {
        saveAs(content, 'example.zip');
      });
    });
  },
  false
);

async function addFileToZip(file, filePath) {
  return new Promise((resolve) => {
    const fileReader = new FileReader();
    fileReader.onload = (event) => {
      zip.file(filePath, event.target.result);
      resolve(true);
    };
    fileReader.readAsArrayBuffer(file);
  });
}

function removeZipRootFolder(path) {
  return path.split('/').slice(1).join('/');
}
