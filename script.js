// 统一错误显示函数
function showError(message, error = null) {
    console.error(message, error);
    alert(message);
}

// --- chrome.storage.local 兼容 localStorage 层 ---
const Storage = (function() {
    let pendingWrites = {};
    let writeTimeout = null;
    let flushResolveQueue = [];
    const WRITE_DELAY = 500;

    function flushWrites() {
        if (Object.keys(pendingWrites).length > 0) {
            const dataToWrite = { ...pendingWrites };
            pendingWrites = {};
            chrome.storage.local.set(dataToWrite, () => {
                if (chrome.runtime.lastError) {
                    console.error('Storage write error:', chrome.runtime.lastError);
                }
                flushResolveQueue.forEach(resolve => resolve());
                flushResolveQueue = [];
            });
        } else {
            flushResolveQueue.forEach(resolve => resolve());
            flushResolveQueue = [];
        }
        writeTimeout = null;
    }

    function scheduleWrite(key, value) {
        pendingWrites[key] = value;
        if (writeTimeout) clearTimeout(writeTimeout);
        writeTimeout = setTimeout(flushWrites, WRITE_DELAY);
    }

    return {
        get(key, defaultVal = null) {
            return new Promise(resolve => {
                chrome.storage.local.get([key], res => {
                    resolve(res[key] ?? defaultVal);
                });
            });
        },
        
        set(key, value) {
            scheduleWrite(key, value);
            return Promise.resolve();
        },
        
        setBatch(items) {
            Object.assign(pendingWrites, items);
            if (writeTimeout) clearTimeout(writeTimeout);
            writeTimeout = setTimeout(flushWrites, WRITE_DELAY);
            return Promise.resolve();
        },
        
        setImmediate(key, value) {
            delete pendingWrites[key];
            return new Promise(resolve => {
                chrome.storage.local.set({ [key]: value }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('Storage write error:', chrome.runtime.lastError);
                    }
                    resolve();
                });
            });
        },
        
        remove(key) {
            if (pendingWrites.hasOwnProperty(key)) {
                delete pendingWrites[key];
            }
            return new Promise(resolve => {
                chrome.storage.local.remove(key, () => {
                    if (chrome.runtime.lastError) {
                        console.error('Storage remove error:', chrome.runtime.lastError);
                    }
                    resolve();
                });
            });
        },
        
        flush() {
            if (writeTimeout) {
                clearTimeout(writeTimeout);
            }
            if (Object.keys(pendingWrites).length > 0) {
                return new Promise(resolve => {
                    flushResolveQueue.push(resolve);
                    flushWrites();
                });
            }
            return Promise.resolve();
        }
    };
})();

window.addEventListener('beforeunload', () => {
    Storage.flush();
});

// 在页面加载早期获取并应用自定义背景，避免闪烁
(async function() {
    // 立即获取自定义背景设置
    const savedBg = await Storage.get('customBg');
    const preloadBg = document.createElement('div');
    preloadBg.id = 'preload-bg';
    preloadBg.className = 'preloaded-bg';
    preloadBg.style.position = 'fixed';
    preloadBg.style.top = '0';
    preloadBg.style.left = '0';
    preloadBg.style.width = '100vw';
    preloadBg.style.height = '100vh';
    preloadBg.style.zIndex = '-3';
    
    // 如果有自定义背景，立即应用
    if (savedBg && savedBg !== 'none') {
        preloadBg.style.backgroundImage = `url('${savedBg}')`;
        preloadBg.style.opacity = '1';
        // 标记有自定义背景，用于CSS样式控制
        document.documentElement.classList.add('has-custom-bg');
    }
    
    // 将预加载背景添加到html根节点最前面
    if (document.documentElement.firstChild) {
        document.documentElement.insertBefore(preloadBg, document.documentElement.firstChild);
    } else {
        document.documentElement.appendChild(preloadBg);
    }
})();

document.addEventListener('DOMContentLoaded', async () => {
    // --- 1. 配置与初始化 ---

    // 搜索相关元素
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    
    const settingsBtn = document.getElementById('settings-trigger');
    const settingsDialog = document.getElementById('settings-dialog');
    const settingsClose = document.getElementById('settings-close');
    
    // 背景相关元素
    const bgUnsplashBtn = document.getElementById('bg-unsplash-btn');
    const bgUploadInput = document.getElementById('bg-upload-input');
    const bgResetBtn = document.getElementById('bg-reset-btn');

    // 数据管理元素
    const exportDataBtn = document.getElementById('export-data-btn');
    const importDataInput = document.getElementById('import-data-input');

    // 布局设置元素
    const colInput = document.getElementById('setting-cols');
    const colValDisplay = document.getElementById('col-val');
    const sizeInput = document.getElementById('setting-size');
    const scaleInput = document.getElementById('setting-scale');
    const scaleValDisplay = document.getElementById('scale-val');
    
    // 颜色模式设置元素
    const colorModeButtons = document.querySelectorAll('.color-mode-buttons .glass-btn');

    // 快捷方式相关元素
    const grid = document.getElementById('shortcuts-grid');
    let dragStartIndex;
    let currentDragElement = null;

    // 编辑对话框元素
    const editDialog = document.getElementById('edit-dialog');
    const nameInput = document.getElementById('shortcut-name');
    const urlInput = document.getElementById('shortcut-url');
    const iconInput = document.getElementById('shortcut-icon'); // 新增图标输入框
    const iconUploadInput = document.getElementById('shortcut-icon-upload'); // 图标上传输入框
    const refreshIconBtn = document.getElementById('refresh-icon-btn'); // 重新获取图标按钮
    const saveBtn = document.getElementById('save-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    let isEditing = false, editIndex = -1;

    // 右键菜单元素
    const contextMenu = document.getElementById('context-menu');
    const menuEdit = document.getElementById('menu-edit');
    const menuDelete = document.getElementById('menu-delete');
    let contextMenuIndex = -1;

    const DEFAULT_SHORTCUTS = [
        { name: "Google", url: "https://google.com" },
        { name: "Bilibili", url: "https://bilibili.com" },
        { name: "GitHub", url: "https://github.com" },
        { name: "Unsplash", url: "https://unsplash.com" }
    ];
    
    let shortcuts = JSON.parse(await Storage.get('shortcuts', JSON.stringify(DEFAULT_SHORTCUTS)));

    // 加载并应用布局设置
    const savedCols = await Storage.get('gridCols', 5);
    const savedSize = await Storage.get('gridSize', 100);
    const savedScale = await Storage.get('scale', 100);
    document.documentElement.style.setProperty('--col-count', savedCols);
    document.documentElement.style.setProperty('--item-size', `${savedSize}px`);
    document.documentElement.style.setProperty('--scale', savedScale / 100);

    // --- 核心：加载并应用背景设置 ---
    const body = document.body;
    let preloadBg = document.getElementById('preload-bg');

    async function applyBackground(bgUrl) {
        // 确保preloadBg元素存在
        if (!preloadBg) {
            preloadBg = document.getElementById('preload-bg');
        }
        
        // 清除存储的主题信息
        await Storage.remove('backgroundThemeInfo');
        
        if (bgUrl && bgUrl !== 'none') {
            // 直接应用背景图片，不再等待onload事件以提升加载速度
            if (preloadBg) {
                preloadBg.style.backgroundImage = `url('${bgUrl}')`;
                preloadBg.style.opacity = '1'; // 显示图片
            }
            
            // 设置CSS变量里的背景图URL
            document.documentElement.style.setProperty('--bg-image', `url('${bgUrl}')`);
            // 添加类名以隐藏默认的 blob 动画层
            document.documentElement.classList.add('has-custom-bg');
            
            // 检测背景颜色
            detectBackgroundColor();
        } else {
            // 移除背景图片
            if (preloadBg) {
                preloadBg.style.backgroundImage = 'none';
                preloadBg.style.opacity = '0';
            }
            document.documentElement.style.setProperty('--bg-image', 'none');
            document.documentElement.classList.remove('has-custom-bg');
            
            // 应用背景后检测背景颜色
            detectBackgroundColor();
        }
    }
    
    // 初始化 Input 值
    colInput.value = savedCols;
    colValDisplay.innerText = savedCols;
    sizeInput.value = savedSize;
    scaleInput.value = savedScale;
    scaleValDisplay.innerText = savedScale + '%';
    
    // 初始化颜色模式设置
    const savedColorMode = await Storage.get('colorMode', 'auto');
    document.querySelector(`.color-mode-buttons .glass-btn[data-mode="${savedColorMode}"]`).classList.add('active');

    // 监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', async (e) => {
        const currentColorMode = await Storage.get('colorMode', 'auto');
        if (currentColorMode === 'auto') {
            // 如果是自动模式，重新检测背景颜色并更新主题
            detectBackgroundColor();
        }
    });
    
    // 确保自动模式下也有高亮显示
    if (savedColorMode === 'auto') {
        const autoButton = document.querySelector(`.color-mode-buttons .glass-btn[data-mode="auto"]`);
        if (autoButton && !autoButton.classList.contains('active')) {
            autoButton.classList.add('active');
        }
        
        // 在自动模式下，立即检测背景颜色
        detectBackgroundColor();
    } else {
        // 对于非自动模式，也要确保颜色类正确应用
        await applyColorMode(savedColorMode);
    }
    
    // 确保在首次加载时始终触发一次颜色检测
    setTimeout(detectBackgroundColor, 100);

    // --- 2. 设置面板逻辑 ---
    settingsBtn.addEventListener('click', () => {
        settingsDialog.showModal();
    });
    
    settingsClose.addEventListener('click', () => settingsDialog.close());
    
    // 点击设置对话框外部关闭对话框
    settingsDialog.addEventListener('click', (e) => {
        if (e.target === settingsDialog) {
            settingsDialog.close();
        }
    });

    // 布局实时监听
    colInput.addEventListener('input', async (e) => {
        colValDisplay.innerText = e.target.value;
        document.documentElement.style.setProperty('--col-count', e.target.value);
        await Storage.set('gridCols', e.target.value);
    });
    
    sizeInput.addEventListener('input', async (e) => {
        document.documentElement.style.setProperty('--item-size', `${e.target.value}px`);
        await Storage.set('gridSize', e.target.value);
    });
    
    scaleInput.addEventListener('input', async (e) => {
        scaleValDisplay.innerText = e.target.value + '%';
        const scaleValue = e.target.value / 100;
        document.documentElement.style.setProperty('--scale', scaleValue);
        await Storage.set('scale', e.target.value);
    });
    
    // 颜色模式设置监听
    colorModeButtons.forEach(button => {
        button.addEventListener('click', async (e) => {
            // 移除所有按钮的激活状态
            colorModeButtons.forEach(btn => btn.classList.remove('active'));
            
            // 为当前点击的按钮添加激活状态
            button.classList.add('active');
            
            // 获取模式值
            const mode = button.dataset.mode;
            
            // 保存设置
            await Storage.set('colorMode', mode);
            
            // 如果是从特定颜色模式切换到自动模式，立即执行颜色检测
            if (mode === 'auto') {
                // 清除旧的主题信息，强制重新计算
                await Storage.remove('backgroundThemeInfo');
                // 执行颜色模式应用
                applyColorMode(mode);
            } else {
                // 应用指定的颜色模式
                applyColorMode(mode);
                // 移除背景主题信息，避免自动模式切换回来时使用旧数据
                await Storage.remove('backgroundThemeInfo');
            }
        });
    });

    // 保存搜索引擎
    saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        const icon = iconInput.value.trim();

        if (name && url) {
            let finalUrl = url;
            if (!url.startsWith('http')) finalUrl = 'https://' + url;
            if (isEditing) {
                shortcuts[editIndex] = { name, url: finalUrl };
                if (icon) {
                    shortcuts[editIndex].icon = icon;
                } else {
                    delete shortcuts[editIndex].icon;
                }
                await Storage.set('shortcuts', JSON.stringify(shortcuts));
                await renderShortcuts();
            } else {
                const newItem = { name, url: finalUrl };
                if (icon) newItem.icon = icon;
                shortcuts.push(newItem);
                await Storage.set('shortcuts', JSON.stringify(shortcuts));
                await renderShortcuts(); 
            }
            
            editDialog.close();
        }
    });
    


    cancelBtn.addEventListener('click', () => editDialog.close());

    // 图片压缩函数
    function compressImage(src, quality = 0.7) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                const maxWidth = 1920;
                const maxHeight = 1080;
                let { width, height } = img;
                
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
                
                if (height > maxHeight) {
                    width *= maxHeight / height;
                    height = maxHeight;
                }
                
                canvas.width = width;
                canvas.height = height;
                
                try {
                    ctx.drawImage(img, 0, 0, width, height);
                    const dataURL = canvas.toDataURL('image/jpeg', quality);
                    resolve(dataURL);
                } catch (e) {
                    reject(new Error('图片压缩失败（可能受 CORS 限制）: ' + e.message));
                }
            };
            img.onerror = function(err) {
                reject(new Error('图片加载失败'));
            };
            img.src = src;
        });
    }

    // [背景功能 1] 获取 Unsplash 随机图
    // 使用一个稳定的第三方源来代理 Unsplash 随机图，避免 API Key
    bgUnsplashBtn.addEventListener('click', async () => {
        const originalText = bgUnsplashBtn.innerHTML;
        bgUnsplashBtn.innerHTML = '获取中...';
        bgUnsplashBtn.disabled = true;
        
        try {
            // 请求一个随机图片 URL (这里使用 picsum 作为稳定演示，你可以换成其他源)
            // 如果需要真实的 Unsplash，可以使用 https://source.unsplash.com/random/1920x1080 (但不稳定)
            // 这里用一个技巧：请求一个会重定向到最终图片地址的 URL
            const response = await fetch('https://picsum.photos/1920/1080');
            const finalUrl = response.url; // 获取重定向后的最终 URL
            
            // 压缩图片
            const compressedImage = await compressImage(finalUrl, 0.7);
            
            // 预加载图片以减少闪烁
            const img = new Image();
            img.onload = async function() {
                await Storage.setImmediate('customBg', compressedImage);
                await applyBackground(compressedImage);
            };
            img.src = compressedImage;
        } catch (error) {
            showError('获取图片失败，请重试');
            console.error(error);
        } finally {
            bgUnsplashBtn.innerHTML = originalText;
            bgUnsplashBtn.disabled = false;
        }
    });

    // [背景功能 2] 上传本地图片 (转 Base64 存储)
    bgUploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        if (file.size > 5 * 1024 * 1024) {
            showError('图片太大啦，请选择 5MB 以内的图片');
            bgUploadInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async function(event) {
            const base64String = event.target.result;
            try {
                const compressedImage = await compressImage(base64String, 0.7);
                
                const img = new Image();
                img.onload = async function() {
                    await Storage.setImmediate('customBg', compressedImage);
                    await applyBackground(compressedImage);
                };
                img.src = compressedImage;
            } catch (e) {
                showError('存储失败，可能是图片转换后太大了', e);
            }
        };
        reader.readAsDataURL(file);
        bgUploadInput.value = '';
    });

    // [背景功能 3] 重置背景
    bgResetBtn.addEventListener('click', async () => {
        await Storage.remove('customBg');
        await Storage.remove('backgroundThemeInfo'); // 同时清除主题信息
        await applyBackground('none');
        bgUploadInput.value = ''; // 清空文件 input
    });

    // 数据导出功能
    exportDataBtn.addEventListener('click', async () => {
        // 收集所有需要导出的数据
        const exportData = {
            shortcuts: shortcuts,
            gridCols: await Storage.get('gridCols', 5),
            gridSize: await Storage.get('gridSize', 110),
            scale: await Storage.get('scale', 100), // 添加显示比例设置
            customBg: await Storage.get('customBg'),
            colorMode: await Storage.get('colorMode', 'auto') // 添加颜色模式设置
        };
        
        // 收集所有favicon缓存
        const favicons = {};
        // 获取所有存储项
        await new Promise(resolve => {
            chrome.storage.local.get(null, (items) => {
                Object.keys(items).forEach(key => {
                    if (key.startsWith('favicon_')) {
                        favicons[key] = items[key];
                    }
                });
                resolve();
            });
        });
        exportData.favicons = favicons;

        // 创建一个 Blob 对象并下载
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], {type: 'application/json'});
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'liquid-newtab-data.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });

    // 数据导入功能
    importDataInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async function(event) {
            try {
                const importData = JSON.parse(event.target.result);
                
                // 导入数据
                if (importData.shortcuts) {
                    shortcuts = importData.shortcuts;
                    await Storage.setImmediate('shortcuts', JSON.stringify(shortcuts));
                }
                
                if (importData.gridCols) {
                    await Storage.setImmediate('gridCols', importData.gridCols);
                }
                
                if (importData.gridSize) {
                    await Storage.setImmediate('gridSize', importData.gridSize);
                }
                
                // 导入显示比例设置
                if (importData.scale !== undefined) {
                    await Storage.setImmediate('scale', importData.scale);
                }
                
                if (importData.customBg !== undefined) {
                    if (importData.customBg) {
                        await Storage.setImmediate('customBg', importData.customBg);
                    } else {
                        await Storage.remove('customBg');
                    }
                    await Storage.remove('backgroundThemeInfo'); // 清除主题信息
                    await applyBackground(importData.customBg || null);
                }
                
                // 导入颜色模式设置
                if (importData.colorMode !== undefined) {
                    await Storage.setImmediate('colorMode', importData.colorMode);
                }
                
                // 导入favicon缓存
                if (importData.favicons) {
                    // 收集所有favicon键
                    const faviconKeys = [];
                    await new Promise(resolve => {
                        chrome.storage.local.get(null, (items) => {
                            Object.keys(items).forEach(key => {
                                if (key.startsWith('favicon_')) {
                                    faviconKeys.push(key);
                                }
                            });
                            resolve();
                        });
                    });
                    
                    // 清除现有的favicon缓存
                    if (faviconKeys.length > 0) {
                        await Storage.remove(faviconKeys);
                    }
                    
                    // 导入新的favicon缓存
                    await Storage.setBatch(importData.favicons);
                }
                
                // 更新UI
                const gridCols = await Storage.get('gridCols', 5);
                const gridSize = await Storage.get('gridSize', 110);
                const scale = await Storage.get('scale', 100);
                const colorMode = await Storage.get('colorMode', 'auto');
                
                document.documentElement.style.setProperty('--col-count', gridCols);
                document.documentElement.style.setProperty('--item-size', `${gridSize}px`);
                document.documentElement.style.setProperty('--scale', scale / 100);
                colInput.value = gridCols;
                colValDisplay.innerText = gridCols;
                sizeInput.value = gridSize;
                scaleInput.value = scale;
                scaleValDisplay.innerText = scale + '%';
                
                // 更新颜色模式按钮状态
                document.querySelectorAll('.color-mode-buttons .glass-btn').forEach(btn => {
                    btn.classList.remove('active');
                });
                document.querySelector(`.color-mode-buttons .glass-btn[data-mode="${colorMode}"]`).classList.add('active');
                
                await renderShortcuts();
                
                showError('数据导入成功！');
            } catch (error) {
                showError('导入数据失败，请确保选择了有效的JSON文件。', error);
            }
        };
        reader.readAsText(file);
        // 清空input以便下次选择相同文件也能触发change事件
        importDataInput.value = '';
    });

    // --- 3. 搜索功能 ---
    function performSearch() {
        const query = searchInput.value.trim();
        if (query) {
            chrome.runtime.sendMessage({
                action: "performSearch",
                text: query
            });
        }
    }
    
    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('keypress', (e) => { 
        if (e.key === 'Enter') performSearch(); 
    });

    // --- 4. 快捷方式渲染 ---
    let shortcutsAbortController = new AbortController();

    async function renderShortcuts() {
        shortcutsAbortController.abort();
        shortcutsAbortController = new AbortController();
        const signal = shortcutsAbortController.signal;
        
        const fragment = document.createDocumentFragment();
        
        for (let index = 0; index < shortcuts.length; index++) {
            const item = shortcuts[index];
            
            const div = document.createElement('div');
            div.className = 'shortcut-item glass-element';
            div.draggable = true;
            div.dataset.index = index;
            
            const img = document.createElement('img');
            const span = document.createElement('span');
            div.appendChild(img);
            div.appendChild(span);
            
            let faviconUrl = item.icon; 
            
            if (!faviconUrl) {
                const urlObj = new URL(chrome.runtime.getURL("/_favicon/"));
                urlObj.searchParams.set("pageUrl", item.url); 
                urlObj.searchParams.set("size", "256");
                faviconUrl = urlObj.toString();
            }
            
            img.src = faviconUrl;
            img.alt = item.name;
            span.textContent = item.name;
            span.title = item.name;
            
            div.addEventListener('click', () => { 
                window.location.href = item.url; 
            }, { signal });
            div.addEventListener('contextmenu', (e) => showContextMenu(e, index), { signal });
            addDragEvents(div, signal);
            
            fragment.appendChild(div);
        }
        
        grid.innerHTML = '';
        grid.appendChild(fragment);
        
        await Storage.set('shortcuts', JSON.stringify(shortcuts));
    }
    
    // 页面加载完成后渲染快捷方式
    await renderShortcuts();
    
    // 初始化右键菜单颜色模式
    // 不再需要单独调用，因为在updateTextColorClasses中已经处理

    // --- 5. 拖拽逻辑 ---
    function initDragAndDrop() {
        // 为grid容器添加必要的事件监听器
        grid.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        
        grid.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    }
    
    // 全局状态变量，确保所有元素共享同一份状态
    let lastInsertPosition = null;
    
    function addDragEvents(item, signal) {
        item.addEventListener('dragstart', (e) => {
            dragStartIndex = parseInt(item.dataset.index);
            currentDragElement = item;
            item.classList.add('dragging');
            item.style.opacity = '0.5';
            
            e.dataTransfer.setData('text/plain', item.dataset.index);
            e.dataTransfer.effectAllowed = 'move';
            
            lastInsertPosition = null;
        }, { signal });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, { signal });
        
        item.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (currentDragElement !== item) {
                const fromIndex = dragStartIndex;
                const toIndex = parseInt(item.dataset.index);
                
                if (fromIndex !== toIndex) {
                    const insertPosition = `${fromIndex}-${toIndex}`;
                    if (lastInsertPosition === insertPosition) return;
                    lastInsertPosition = insertPosition;
                    
                    if (fromIndex < toIndex) {
                        item.parentNode.insertBefore(currentDragElement, item.nextSibling);
                    } else {
                        item.parentNode.insertBefore(currentDragElement, item);
                    }
                    
                    dragStartIndex = toIndex;
                }
            }
        }, { signal });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, { signal });
        
        item.addEventListener('dragend', async () => {
            const shortcutItems = grid.querySelectorAll('.shortcut-item');
            const newShortcuts = [];
            
            shortcutItems.forEach((shortcutItem) => {
                const itemIndex = parseInt(shortcutItem.dataset.index);
                newShortcuts.push(shortcuts[itemIndex]);
            });
            
            shortcutItems.forEach((shortcutItem, index) => {
                shortcutItem.dataset.index = index;
            });
            
            shortcuts = newShortcuts;
            await Storage.set('shortcuts', JSON.stringify(shortcuts));
            
            if (currentDragElement) {
                currentDragElement.classList.remove('dragging');
                currentDragElement.style.opacity = '';
            }
            currentDragElement = null;
            lastInsertPosition = null;
        }, { signal });
    }
    


    // --- 6. 增删改查弹窗逻辑 ---
    const addBtn = document.getElementById('add-shortcut-btn');
    
    addBtn.addEventListener('click', () => { 
        isEditing = false; 
        nameInput.value = ''; 
        urlInput.value = '';
        iconInput.value = ''; // 清空图标输入框
        editDialog.showModal(); 
    });

    // 图标上传处理
    iconUploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // 检查文件类型
        if (!file.type.match('image.*')) {
            showError('请选择图片文件');
            return;
        }
        
        // 限制文件大小 (例如 500KB)
        if (file.size > 500 * 1024) {
            showError('图片太大啦，请选择 500KB 以内的图片');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(event) {
            iconInput.value = event.target.result;
        };
        reader.readAsDataURL(file);
    });
    
    // 重新获取图标按钮事件处理
    refreshIconBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!url) {
            showError('请输入网址后再重新获取图标');
            return;
        }
        
        // 使用 Chrome 原生 Favicon API 获取图标
        const urlObj = new URL(chrome.runtime.getURL("/_favicon/"));
        urlObj.searchParams.set("pageUrl", url.startsWith('http') ? url : 'https://' + url);
        urlObj.searchParams.set("size", "128");
        iconInput.value = urlObj.toString();
    });
    
    cancelBtn.addEventListener('click', () => editDialog.close());

    // --- 7. 右键菜单 ---
    function showContextMenu(e, index) {
        e.preventDefault(); 
        e.stopPropagation();
        contextMenuIndex = index;
        // 简单的边界检测，防止菜单超出屏幕
        let top = e.clientY; 
        let left = e.clientX;
        // 考虑菜单本身的宽度和高度，避免菜单被截断
        const menuWidth = 120;
        const menuHeight = 80;
        if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - 5;
        if (top + menuHeight > window.innerHeight) top = window.innerHeight - menuHeight - 5;
        contextMenu.style.top = `${top}px`; 
        contextMenu.style.left = `${left}px`;
        
        contextMenu.classList.remove('hidden');
    }
    
    // 点击页面其他地方隐藏菜单
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            contextMenu.classList.add('hidden');
        }
    });
    

    

    
    menuDelete.addEventListener('click', () => { 
        if (contextMenuIndex > -1) { 
            shortcuts.splice(contextMenuIndex, 1); 
            renderShortcuts(); 
            contextMenu.classList.add('hidden');
        } 
    });
    
    menuEdit.addEventListener('click', () => {
        if (contextMenuIndex > -1) {
            isEditing = true; 
            editIndex = contextMenuIndex;
            nameInput.value = shortcuts[editIndex].name; 
            urlInput.value = shortcuts[editIndex].url;
            // 填充图标URL（如果存在）
            iconInput.value = shortcuts[editIndex].icon || '';
            editDialog.showModal();
            contextMenu.classList.add('hidden');
        }
    });
    
    // 应用颜色模式
    async function applyColorMode(mode) {
        // 移除所有颜色模式类
        const body = document.body;
        body.classList.remove('light-bg');
        
        // 根据选择应用颜色模式
        let currentTheme;
        switch (mode) {
            case 'light':
                currentTheme = 'light';
                break;
            case 'dark':
                currentTheme = 'dark';
                break;
            case 'auto':
            default:
                // 恢复自动检测并获取当前主题
                detectBackgroundColor();
                // 从存储中获取检测到的主题
                const themeInfo = await Storage.get('backgroundThemeInfo');
                currentTheme = themeInfo ? JSON.parse(themeInfo).theme : 'dark';
                break;
        }
        
        // 只更新快捷方式和搜索框的颜色类
        await updateTextColorClasses(currentTheme);
        
        // 更新对话框的颜色模式
        await updateDialogColorMode(currentTheme);
    }
    
    // 修复背景亮度检测函数
    function detectBackgroundColor() {
        // 移除之前可能添加的类
        const body = document.body;
        // 移除body上的light-bg类
        body.classList.remove('light-bg');
        
        // 获取预加载背景元素
        const preloadBg = document.getElementById('preload-bg');
        let backgroundImage = '';
        
        // 检查预加载背景是否有图片
        if (preloadBg) {
            const preloadStyle = window.getComputedStyle(preloadBg);
            backgroundImage = preloadStyle.backgroundImage;
        }
        
        // 如果预加载背景没有图片，检查body的背景图
        if (!backgroundImage || backgroundImage === 'none' || !backgroundImage.includes('url')) {
            const bodyStyle = window.getComputedStyle(body);
            backgroundImage = bodyStyle.backgroundImage;
        }
        
        // 如果有自定义背景图
        const urlMatch = backgroundImage.match(/url\(["']?(.*?)["']?\)/);
        let theme = 'dark'; // 默认主题
        let bgUrl = null;
        if (urlMatch && urlMatch[1] && urlMatch[1] !== 'none') {
            bgUrl = urlMatch[1];
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.onload = function() {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    
                    const centerX = Math.floor(img.width / 2);
                    const centerY = Math.floor(img.height / 2);
                    const sampleWidth = Math.floor(img.width / 3);
                    const sampleHeight = Math.floor(img.height / 3);
                    const startX = centerX - Math.floor(sampleWidth / 2);
                    const startY = centerY - Math.floor(sampleHeight / 2);
                    
                    const imageData = ctx.getImageData(startX, startY, sampleWidth, sampleHeight);
                    const data = imageData.data;
                    
                    let totalBrightness = 0;
                    let count = 0;
                    for (let i = 0; i < data.length; i += 4) {
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];
                        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
                        totalBrightness += brightness;
                        count++;
                    }
                    
                    const averageBrightness = totalBrightness / count;
                    
                    if (averageBrightness > 128) {
                        theme = 'light';
                    }
                } catch (e) {
                    console.warn('无法分析背景图片亮度（可能受 CORS 限制），使用默认深色主题', e);
                }
                
                const themeInfo = {
                    theme: theme,
                    bgUrl: bgUrl,
                    systemTheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
                };
                
                (async function() {
                    await Storage.set('backgroundThemeInfo', JSON.stringify(themeInfo));
                    await updateTextColorClasses(theme);
                })();
            };
            img.onerror = function() {
                console.warn('背景图片加载失败，使用默认深色主题');
                const themeInfo = {
                    theme: 'dark',
                    bgUrl: null,
                    systemTheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
                };
                (async function() {
                    await Storage.set('backgroundThemeInfo', JSON.stringify(themeInfo));
                    await updateTextColorClasses('dark');
                })();
            };
            img.src = urlMatch[1];
        } else {
            // 没有自定义背景图，使用默认背景色
            const bgColor = window.getComputedStyle(body).backgroundColor;
            const rgbMatch = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (rgbMatch) {
                const r = parseInt(rgbMatch[1]);
                const g = parseInt(rgbMatch[2]);
                const b = parseInt(rgbMatch[3]);
                const brightness = (r * 299 + g * 587 + b * 114) / 1000;
                
                // 根据亮度设置主题
                if (brightness > 128) {
                    theme = 'light';
                    // 不添加light-bg类，只更新文字和图标颜色
                }
                
                // 存储主题信息和相关上下文
                const themeInfo = {
                    theme: theme,
                    bgUrl: bgUrl,
                    systemTheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
                };
                
                // 异步存储主题信息和更新颜色类
                (async function() {
                    await Storage.set('backgroundThemeInfo', JSON.stringify(themeInfo));
                    await updateTextColorClasses(theme);
                })();
            }
        }
    }
    
    // 更新文本颜色类
    async function updateTextColorClasses(mode) {
        const searchCapsule = document.querySelector('.search-capsule');
        const shortcutsContainer = document.querySelector('.grid-container');
        const addBtn = document.querySelector('.add-btn');
        const settingsBtn = document.querySelector('.settings-btn');
        const contextMenu = document.getElementById('context-menu');
        
        // 移除现有的颜色类
        [searchCapsule, shortcutsContainer, addBtn, settingsBtn].forEach(el => {
            if (el) {
                el.classList.remove('text-color-dark', 'text-color-light', 'icon-color-dark', 'icon-color-light', 'shortcut-color-dark', 'shortcut-color-light');
            }
        });
        
        // 移除右键菜单现有的颜色类
        if (contextMenu) {
            contextMenu.classList.remove('text-color-dark', 'text-color-light');
        }
        
        // 根据模式或主题设置颜色类
        let textColorClass, iconColorClass, shortcutColorClass;
        
        if (mode === 'auto') {
            // 自动模式，从存储中获取主题
            const themeInfo = await Storage.get('backgroundThemeInfo');
            if (themeInfo) {
                const parsedTheme = JSON.parse(themeInfo);
                textColorClass = parsedTheme.theme === 'light' ? 'text-color-dark' : 'text-color-light';
                iconColorClass = parsedTheme.theme === 'light' ? 'icon-color-dark' : 'icon-color-light';
                shortcutColorClass = parsedTheme.theme === 'light' ? 'shortcut-color-dark' : 'shortcut-color-light';
            } else {
                // 默认为浅色文字（深色背景）
                textColorClass = 'text-color-light';
                iconColorClass = 'icon-color-light';
                shortcutColorClass = 'shortcut-color-light';
            }
        } else {
            // 固定模式
            textColorClass = mode === 'light' ? 'text-color-dark' : 'text-color-light';
            iconColorClass = mode === 'light' ? 'icon-color-dark' : 'icon-color-light';
            shortcutColorClass = mode === 'light' ? 'shortcut-color-dark' : 'shortcut-color-light';
        }
        
        // 应用颜色类
        if (searchCapsule) {
            searchCapsule.classList.add(textColorClass, iconColorClass);
        }
        
        if (shortcutsContainer) {
            shortcutsContainer.classList.add(shortcutColorClass);
        }
        
        if (addBtn) {
            addBtn.classList.add(iconColorClass);
        }
        
        if (settingsBtn) {
            settingsBtn.classList.add(iconColorClass);
        }
        
        // 应用右键菜单颜色类
        if (contextMenu) {
            contextMenu.classList.add(textColorClass);
        }
    }
    
    // 确保在 DOM 加载完成后立即更新颜色类
    setTimeout(async () => {
        const savedColorMode = await Storage.get('colorMode', 'auto');
        let currentTheme;
                
        if (savedColorMode === 'auto') {
            // 对于自动模式，尝试从存储中获取主题信息
            const themeInfo = await Storage.get('backgroundThemeInfo');
            if (themeInfo) {
                // 如果有预先计算的主题信息，使用它
                currentTheme = JSON.parse(themeInfo).theme;
            } else {
                // 如果没有预先计算的主题信息，触发背景颜色检测
                detectBackgroundColor();
                // 默认使用深色主题，直到检测完成
                currentTheme = 'dark';
            }
        } else {
            // 对于固定模式，直接使用保存的颜色模式
            currentTheme = savedColorMode;
        }
                
        await updateTextColorClasses(currentTheme);
        
        // 确保在首次加载时也正确应用对话框颜色模式
        await updateDialogColorMode(currentTheme);
    }, 100);
    
    // 更新对话框颜色模式
    async function updateDialogColorMode(mode) {
        const dialogs = document.querySelectorAll('.glass-dialog');
        
        // 移除所有颜色模式类
        dialogs.forEach(dialog => {
            dialog.classList.remove('light-bg', 'dark-mode');
        });
        
        // 根据选择应用颜色模式
        switch (mode) {
            case 'light':
                dialogs.forEach(dialog => {
                    dialog.classList.add('light-bg');
                });
                break;
            case 'dark':
                dialogs.forEach(dialog => {
                    dialog.classList.add('dark-mode');
                });
                break;
            case 'auto':
            default:
                // 自动模式，从存储中获取主题
                const themeInfo = await Storage.get('backgroundThemeInfo');
                if (themeInfo) {
                    const parsedTheme = JSON.parse(themeInfo);
                    if (parsedTheme.theme === 'light') {
                        dialogs.forEach(dialog => {
                            dialog.classList.add('light-bg');
                        });
                    } else {
                        dialogs.forEach(dialog => {
                            dialog.classList.add('dark-mode');
                        });
                    }
                } else {
                    // 默认为深色模式
                    dialogs.forEach(dialog => {
                        dialog.classList.add('dark-mode');
                    });
                }
                break;
        }
    }
    
    initDragAndDrop();
});
