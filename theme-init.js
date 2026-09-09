// 首绘前的同步主题初始化：必须以外部脚本形式引入（MV3 的 CSP 禁止扩展页面执行内联脚本），
// 在样式首次渲染前为 <html> 挂上 theme-light / theme-dark，避免自动模式下闪现默认深色。
// 读取的 localStorage 键由 script.js 的 applyColorMode / detectBackgroundColor 权威写入。
(function () {
    try {
        var mode = localStorage.getItem('_colorMode') || 'auto';
        var t;
        if (mode === 'light' || mode === 'dark') {
            t = mode;
        } else {
            // 自动模式：用上次权威计算结果，缺失时回退系统偏好
            t = localStorage.getItem('_resolvedTheme')
                || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        }
        if (t === 'light' || t === 'dark') {
            document.documentElement.classList.add('theme-' + t);
        }
    } catch (e) {}
})();

// 同步应用已缓存的壁纸镜像（_bgImage 由 script.js 的 applyBackground / 启动
// 预处理权威写入），使首次绘制即为自定义/必应背景，避免先闪现默认底色、
// 再等 chrome.storage 异步读取（数 MB data URL 反序列化 + 解码）后切换。
// 校验口径与 script.js 的 sanitizeBackgroundValue 保持一致（data URL 白名单
// 前缀或 http(s) 链接），防注入。
(function () {
    try {
        var bg = localStorage.getItem('_bgImage');
        if (bg && (
            bg.indexOf('data:image/png;base64,') === 0 ||
            bg.indexOf('data:image/jpeg;base64,') === 0 ||
            bg.indexOf('data:image/jpg;base64,') === 0 ||
            bg.indexOf('data:image/webp;base64,') === 0 ||
            bg.indexOf('https://') === 0 ||
            bg.indexOf('http://') === 0
        )) {
            document.documentElement.style.setProperty('--bg-image', "url('" + bg + "')");
            document.documentElement.classList.add('has-custom-bg');
        }
    } catch (e) {}
})();
