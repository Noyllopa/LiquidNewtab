chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request);

  if (request.action === "fetchFavicon") {
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
    return true; // 异步响应
  }

  if (request.action === "performSearch") {
    try {
      console.log("Executing search with text:", request.text);
      chrome.search.query({
        text: request.text,
        disposition: 'NEW_TAB'
      });
      console.log("Search executed successfully");
    } catch (e) {
      console.error("Search failed:", e);
    }
    return true;
  }
});
