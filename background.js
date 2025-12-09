chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request);

  if (request.action === "fetchFavicon") {
    fetch(request.url)
      .then(res => res.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({ success: true, dataUrl: reader.result });
        };
        reader.readAsDataURL(blob);
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // 关键：保持异步响应
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
