# Liquid Newtab

一个自定义新标签页扩展，替换 Chrome 默认新标签页：搜索框、快捷方式网格、壁纸，以及基于 SVG 位移贴图的液态玻璃材质。

## 功能

- **快捷方式**：拖拽排序，右键编辑或删除；图标可自动抓取，也可手动填 URL 或上传图片
- **搜索**：回车即用系统默认搜索引擎搜索
- **背景**：动态光球、必应每日壁纸、自定义图片三种模式
- **外观**：浅色 / 深色 / 自动，自动模式下按壁纸亮度决定；液态玻璃参数可实时调整
- **布局**：列数、图标大小、整体缩放可调
- **数据**：设置与快捷方式可导出为 JSON 备份，支持导入还原

## 安装

Chrome 商店：[安装](https://chrome.google.com/webstore/detail/nfpbmpokfnpmikniaoindhbjjpkeglkl)

手动安装：克隆本仓库，打开 `chrome://extensions/`，开启右上角「开发者模式」，点「加载已解压的扩展程序」并选择项目目录。

需要 Chrome 116 或更高版本。

## 文件

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | 扩展配置 |
| `newtab.html` | 新标签页结构 |
| `style.css` | 样式与主题令牌 |
| `script.js` | 页面逻辑：设置、快捷方式、背景、主题 |
| `background.js` | Service Worker：图标抓取、壁纸下载、快捷方式串行写入 |
| `liquid-glass.js` | 液态玻璃折射滤镜引擎 |
| `theme-init.js` | 首绘前的主题初始化，避免主题闪烁 |

## 权限与网络请求

扩展声明了 `storage`、`unlimitedStorage`、`search`、`favicon` 权限，以及 `http(s)://*/*` 主机权限。主机权限用于下载必应壁纸和用户指定的远程图标，因为这两类请求的目标域名无法预先枚举。

实际会访问的外部服务：

- 抓取网站图标：Google（`t1.gstatic.com`、`www.google.com`）、DuckDuckGo、icon.horse
- 必应壁纸：`cn.bing.com` 的 HPImageArchive 接口
- 自定义远程图标：保存时请求一次该图标 URL，下载后以 data URL 形式存在本地

上传的背景和图标只保存在浏览器本地扩展存储中，不会上传。除此之外扩展不会向外部发送数据。

## 致谢

液态玻璃效果参考 kube.io 的 [Liquid Glass in the Browser: Refraction with CSS and SVG](https://kube.io/blog/liquid-glass-css-svg/)：表面轮廓函数、基于 Snell–Descartes 定律的折射剖面、归一化位移贴图与边缘高光的做法均来自该文。设计语言灵感来自 Apple 在 WWDC 2025 公布的 Liquid Glass。

## 许可证

MIT License
