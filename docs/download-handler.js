/**
 * Download Handler Module
 * 
 * Manages client-side file downloads via blob.
 */

class DownloadHandler {
  /**
   * Trigger download of ArrayBuffer as file
   * @param {ArrayBuffer} data - File data
   * @param {string} filename - Desired filename
   * @param {string} mimeType - MIME type (default: application/octet-stream)
   */
  static download(data, filename = 'download', mimeType = 'application/octet-stream') {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
  }

  /**
   * Trigger download of text as file
   * @param {string} text - Text content
   * @param {string} filename - Desired filename
   * @param {string} mimeType - MIME type (default: text/plain)
   */
  static downloadText(text, filename = 'download.txt', mimeType = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
  }

  /**
   * Get size of download in human-readable format
   * @param {number} bytes - Number of bytes
   * @returns {string} Formatted size
   */
  static formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIdx = 0;

    while (size >= 1024 && unitIdx < units.length - 1) {
      size /= 1024;
      unitIdx++;
    }

    return `${size.toFixed(2)} ${units[unitIdx]}`;
  }
}

export default DownloadHandler;
