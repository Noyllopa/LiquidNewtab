chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Received message:', request);

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
