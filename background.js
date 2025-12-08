// Background script to fetch favicons and bypass CORS restrictions

// 简化 background script，只保留必要的功能
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request);
  
  if (request.action === "fetchFavicon") {
    fetch(request.url, { cache: "force-cache" })
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onload = () => {
          sendResponse({ success: true, dataUrl: reader.result });
        };
        reader.onerror = () => {
          sendResponse({ success: false, error: "Failed to read blob data" });
        };
        reader.readAsDataURL(blob);
      })
      .catch(error => {
        console.error('Error fetching favicon:', error);
        sendResponse({ success: false, error: error.message });
      });
      
    // Return true to indicate we will send a response asynchronously
    return true;
  }
});
