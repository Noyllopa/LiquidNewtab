// Background script to fetch favicons and bypass CORS restrictions

// 简化 background script，只保留必要的功能
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request);
  
  if (request.action === "fetchFavicon") {
    // 使用 XMLHttpRequest 替代 fetch 来更好地处理错误
    const xhr = new XMLHttpRequest();
    xhr.open('GET', request.url, true);
    xhr.responseType = 'blob';
    
    xhr.onload = function() {
      if (xhr.status === 200) {
        const reader = new FileReader();
        reader.onload = function() {
          sendResponse({ success: true, dataUrl: reader.result });
        };
        reader.onerror = function() {
          sendResponse({ success: false, error: "Failed to read blob data" });
        };
        reader.readAsDataURL(xhr.response);
      } else {
        sendResponse({ success: false, error: `HTTP error! status: ${xhr.status}` });
      }
    };
    
    xhr.onerror = function() {
      sendResponse({ success: false, error: "Network error occurred" });
    };
    
    xhr.send();
    
    // Return true to indicate we will send a response asynchronously
    return true;
  }
});