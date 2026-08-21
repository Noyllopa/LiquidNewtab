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
