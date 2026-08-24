# Liquid Newtab

一个自定义浏览器新标签页扩展程序。

## 功能特点

- 美观的自定义新标签页界面
- 快速访问常用网站
- 简洁现代的设计风格
- 轻量级扩展，不占用过多系统资源

## 安装方式

### Chrome 商店安装（推荐）

点击下方链接直接安装：

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Install-green.svg)](https://chrome.google.com/webstore/detail/nfpbmpokfnpmikniaoindhbjjpkeglkl)

### 开发者模式安装

1. 下载或克隆本仓库代码
2. 打开浏览器扩展管理页面 (chrome://extensions/)
3. 开启"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择本项目所在文件夹

## 文件说明

- [manifest.json](manifest.json) - 扩展配置文件
- [newtab.html](newtab.html) - 新标签页主界面
- [style.css](style.css) - 页面样式文件
- [script.js](script.js) - 前端交互逻辑
- [background.js](background.js) - 后台运行脚本
- [liquid-glass.js](liquid-glass.js) - 液态玻璃物理折射滤镜引擎
- [theme-init.js](theme-init.js) - 首绘前主题初始化（防闪烁）

## 外部服务说明

- 自动获取网站图标时，会向 Google、DuckDuckGo 或 icon.horse 查询对应域名的 favicon。
- 使用随机必应壁纸功能时，会请求 `api.bimg.cc` 获取远程图片。
- 上传的本地背景和图标仅保存在浏览器本地扩展存储中。

## 使用方法

安装扩展后，每次打开新标签页时会自动显示自定义界面。

## 致谢

液态玻璃效果（[liquid-glass.js](liquid-glass.js)）的实现基于以下资料的思路与方法，特此致谢：

- **[Liquid Glass in the Browser: Refraction with CSS and SVG — kube.io](https://kube.io/blog/liquid-glass-css-svg/)** —— 本项目玻璃折射效果的实现参考：表面轮廓函数（凸方圆/凸圆/凹面/凸缘）、基于 Snell–Descartes 定律的折射剖面预计算、归一化位移向量场生成 SVG 位移贴图（`maximumDisplacement` 直接用作 `feDisplacementMap` 的 `scale`），以及边缘镜面高光（rim light）的合成方式均源自该博文。
- 效果灵感来自 Apple 在 WWDC 2025 引入的 **Liquid Glass** 设计语言。

## 许可证

MIT License
