// 在页面加载早期获取并应用自定义背景，避免闪烁
(function() {
    // 立即获取自定义背景设置
    const savedBg = localStorage.getItem('customBg');
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

document.addEventListener('DOMContentLoaded', () => {
    // --- 1. 配置与初始化 ---
    const defaultEngines = {
        google: { name: "Google", url: "https://www.google.com/search?q=%s" },
        baidu: { name: "Baidu", url: "https://www.baidu.com/s?wd=%s" },
        bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" }
    };

    // 搜索引擎相关元素
    const engineSelector = document.getElementById('engine-selector');
    const engineLabel = document.getElementById('engine-label');
    const engineDropdown = document.getElementById('engine-dropdown');
    const engineOptions = document.querySelectorAll('.engine-option');
    
    // 设置相关元素
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

    // 搜索引擎设置相关元素
    const engineList = document.getElementById('engine-list');
    const addEngineBtn = document.getElementById('add-engine-btn');

    // 布局设置元素
    const colInput = document.getElementById('setting-cols');
    const colValDisplay = document.getElementById('col-val');
    const sizeInput = document.getElementById('setting-size');
    const scaleInput = document.getElementById('setting-scale');
    const scaleValDisplay = document.getElementById('scale-val');
    
    // 颜色模式设置元素
    const colorModeInputs = document.querySelectorAll('input[name="color-mode"]');
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
    const saveBtn = document.getElementById('save-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    let isEditing = false, editIndex = -1;
    
    // 搜索引擎对话框元素
    const engineDialog = document.getElementById('engine-dialog');
    const engineNameInput = document.getElementById('engine-name');
    const engineUrlInput = document.getElementById('engine-url');
    const engineSaveBtn = document.getElementById('engine-save-btn');
    const engineCancelBtn = document.getElementById('engine-cancel-btn');

    // 搜索相关元素
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');

    // 右键菜单元素
    const contextMenu = document.getElementById('context-menu');
    const menuEdit = document.getElementById('menu-edit');
    const menuDelete = document.getElementById('menu-delete');
    let contextMenuIndex = -1;

    // 加载保存的搜索引擎列表
    let engines = JSON.parse(localStorage.getItem('engines')) || {...defaultEngines};
    
    // 加载首选搜索引擎
    let preferredEngine = localStorage.getItem('preferredEngine') || 'google';
    
    // 默认快捷方式数据
    let shortcuts = JSON.parse(localStorage.getItem('shortcuts')) || [
        { name: "Google", url: "https://google.com" },
        { name: "Bilibili", url: "https://bilibili.com" },
        { name: "GitHub", url: "https://github.com" },
        { name: "Unsplash", url: "https://unsplash.com" }
    ];

    // 加载并应用布局设置
    const savedCols = localStorage.getItem('gridCols') || 5;
    const savedSize = localStorage.getItem('gridSize') || 110;
    const savedScale = localStorage.getItem('scale') || 100;
    document.documentElement.style.setProperty('--col-count', savedCols);
    document.documentElement.style.setProperty('--item-size', `${savedSize}px`);
    document.documentElement.style.setProperty('--scale', savedScale / 100);

    // --- 核心：加载并应用背景设置 ---
    const body = document.body;
    let preloadBg = document.getElementById('preload-bg');

    function applyBackground(bgUrl) {
        // 确保preloadBg元素存在
        if (!preloadBg) {
            preloadBg = document.getElementById('preload-bg');
        }
        
        // 清除存储的主题信息
        localStorage.removeItem('backgroundThemeInfo');
        
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
    const savedColorMode = localStorage.getItem('colorMode') || 'auto';
    document.querySelector(`.color-mode-buttons .glass-btn[data-mode="${savedColorMode}"]`).classList.add('active');

    // 监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', (e) => {
        const currentColorMode = localStorage.getItem('colorMode') || 'auto';
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
    }

    // 初始化搜索引擎设置
    updateEngineSelector();

    // --- 2. 设置面板逻辑 ---
    settingsBtn.addEventListener('click', () => {
        settingsDialog.showModal();
        renderEngineList();
    });
    
    settingsClose.addEventListener('click', () => settingsDialog.close());
    
    // 点击设置对话框外部关闭对话框
    settingsDialog.addEventListener('click', (e) => {
        if (e.target === settingsDialog) {
            settingsDialog.close();
        }
    });
    
    // 搜索引擎拖动相关变量
    let dragSrcElement = null;
    let dragSrcKey = null;

    // 布局实时监听
    colInput.addEventListener('input', (e) => {
        colValDisplay.innerText = e.target.value;
        document.documentElement.style.setProperty('--col-count', e.target.value);
        localStorage.setItem('gridCols', e.target.value);
    });
    
    sizeInput.addEventListener('input', (e) => {
        document.documentElement.style.setProperty('--item-size', `${e.target.value}px`);
        localStorage.setItem('gridSize', e.target.value);
    });
    
    scaleInput.addEventListener('input', (e) => {
        scaleValDisplay.innerText = e.target.value + '%';
        const scaleValue = e.target.value / 100;
        document.documentElement.style.setProperty('--scale', scaleValue);
        localStorage.setItem('scale', e.target.value);
    });
    
    // 颜色模式设置监听
    colorModeButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            // 移除所有按钮的激活状态
            colorModeButtons.forEach(btn => btn.classList.remove('active'));
            
            // 为当前点击的按钮添加激活状态
            button.classList.add('active');
            
            // 获取模式值
            const mode = button.dataset.mode;
            
            // 保存设置
            localStorage.setItem('colorMode', mode);
            
            // 如果是从特定颜色模式切换到自动模式，立即执行颜色检测
            if (mode === 'auto') {
                // 清除旧的主题信息，强制重新计算
                localStorage.removeItem('backgroundThemeInfo');
                // 执行颜色模式应用
                applyColorMode(mode);
            } else {
                // 应用指定的颜色模式
                applyColorMode(mode);
                // 移除背景主题信息，避免自动模式切换回来时使用旧数据
                localStorage.removeItem('backgroundThemeInfo');
            }
        });
    });

    // 搜索引擎选择器点击事件
    engineSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        engineDropdown.classList.toggle('hidden');
        
        // 动态定位下拉菜单，确保与图标对齐
        const selectorRect = engineSelector.getBoundingClientRect();
        const wrapperRect = document.querySelector('.search-wrapper').getBoundingClientRect();
        
        // 水平居中对齐
        const leftPos = selectorRect.left - wrapperRect.left + (selectorRect.width / 2) - 60; // 60 is half of 120px width
        // 垂直定位在engine-selector下方
        const topPos = selectorRect.bottom - wrapperRect.top;
        
        engineDropdown.style.left = leftPos + 'px';
        engineDropdown.style.top = topPos + 'px';
        
        // 检测主题以应用正确的下拉菜单样式
        let isLightMode = false;
        
        // 获取当前颜色模式设置
        const savedColorMode = localStorage.getItem('colorMode') || 'auto';
        
        if (savedColorMode === 'auto') {
            // 自动模式，从存储中获取主题
            const themeInfo = localStorage.getItem('backgroundThemeInfo');
            if (themeInfo) {
                const parsedTheme = JSON.parse(themeInfo);
                isLightMode = parsedTheme.theme === 'light';
            }
        } else {
            // 固定模式
            isLightMode = savedColorMode === 'light';
        }
        
        // 移除直接设置的样式，让CSS规则生效
        const engineOptions = engineDropdown.querySelectorAll('.engine-option');
        engineOptions.forEach(option => {
            const span = option.querySelector('span');
            option.style.color = '';
            if (span) span.style.color = '';
        });
        
        if (isLightMode) {
            engineDropdown.classList.add('light-bg');
        } else {
            engineDropdown.classList.remove('light-bg');
        }
    });

    // 点击其他地方关闭下拉菜单
    document.addEventListener('click', (e) => {
        if (!engineSelector.contains(e.target) && !engineDropdown.contains(e.target)) {
            engineDropdown.classList.add('hidden');
        }
    });

    // 搜索引擎选项点击事件
    function updateEngineOptions() {
        // 清空现有选项
        engineDropdown.innerHTML = '';
        
        // 为每个引擎创建选项
        Object.keys(engines).forEach(key => {
            const engine = engines[key];
            const option = document.createElement('div');
            option.className = 'engine-option';
            option.dataset.value = key;
            option.innerHTML = `<span>${engine.name}</span>`;
            option.addEventListener('click', () => {
                preferredEngine = key;
                localStorage.setItem('preferredEngine', preferredEngine);
                updateEngineSelector();
                engineDropdown.classList.add('hidden');
            });
            engineDropdown.appendChild(option);
        });
    }
    
    // 初始更新引擎选项
    updateEngineOptions();

    // 渲染搜索引擎列表
    function renderEngineList() {
        engineList.innerHTML = '';
        Object.keys(engines).forEach(key => {
            const engine = engines[key];
            const engineItem = document.createElement('div');
            engineItem.className = 'engine-item';
            engineItem.draggable = true;
            engineItem.dataset.key = key;
            engineItem.innerHTML = `
                <div class="engine-info">
                    <div class="engine-name">${engine.name}</div>
                    <div class="engine-url">${engine.url}</div>
                </div>
                <div class="engine-actions">
                    <button class="edit-engine" data-key="${key}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="delete-engine" data-key="${key}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            `;
            engineList.appendChild(engineItem);
        });

        // 添加编辑和删除事件监听器
        document.querySelectorAll('.edit-engine').forEach(button => {
            button.addEventListener('click', (e) => {
                const key = e.currentTarget.dataset.key;
                editEngine(key);
            });
        });

        document.querySelectorAll('.delete-engine').forEach(button => {
            button.addEventListener('click', (e) => {
                const key = e.currentTarget.dataset.key;
                deleteEngine(key);
            });
        });
        
        // 添加拖动事件监听器
        addEngineDragEvents();
    }

    // 编辑搜索引擎
    function editEngine(key) {
        const engine = engines[key];
        engineNameInput.value = engine.name;
        engineUrlInput.value = engine.url;
        isEditing = true;
        editIndex = key;  // 使用key而不是数字索引，以便区分搜索引擎和快捷方式
        engineDialog.showModal();
    }

    // 删除搜索引擎
    function deleteEngine(key) {
        // 确保至少有一个搜索引擎
        if (Object.keys(engines).length <= 1) {
            alert('至少需要保留一个搜索引擎');
            return;
        }

        // 如果删除的是当前首选搜索引擎，则切换到第一个搜索引擎
        if (preferredEngine === key) {
            const engineKeys = Object.keys(engines);
            const firstEngineKey = engineKeys.find(k => k !== key);
            preferredEngine = firstEngineKey;
            localStorage.setItem('preferredEngine', preferredEngine);
            updateEngineSelector();
        }

        delete engines[key];
        localStorage.setItem('engines', JSON.stringify(engines));
        renderEngineList();
    }

    // 添加搜索引擎按钮事件
    addEngineBtn.addEventListener('click', () => {
        engineNameInput.value = '';
        engineUrlInput.value = '';
        engineDialog.showModal();
    });

    // 保存搜索引擎
    saveBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        const icon = iconInput.value.trim(); // 获取图标URL

        if (name && url) {
            // 添加/编辑快捷方式
            let finalUrl = url;
            if (!url.startsWith('http')) finalUrl = 'https://' + url;
            if (isEditing) {
                // 检查是否在编辑搜索引擎
                if (editIndex in engines) {
                    // 编辑搜索引擎
                    engines[editIndex] = { name, url: finalUrl };
                    localStorage.setItem('engines', JSON.stringify(engines));
                    renderEngineList();
                    updateEngineSelector();
                } else {
                    // 检查URL是否发生变化
                    const oldUrl = shortcuts[editIndex].url;
                    const urlChanged = oldUrl !== finalUrl;
                    
                    // 编辑快捷方式
                    shortcuts[editIndex] = { name, url: finalUrl };
                    // 如果提供了图标（包括空字符串），则设置图标属性
                    if (icon !== undefined && icon !== null) {
                        shortcuts[editIndex].icon = icon || undefined;
                    } else if (shortcuts[editIndex].icon) {
                        // 如果原来有图标但没有提供新图标，则保留原图标
                        // 这种情况理论上不会发生，因为input会保留原值
                    }
                    // 保存到localStorage
                    localStorage.setItem('shortcuts', JSON.stringify(shortcuts));
                    renderShortcuts();
                    
                    // 如果URL改变了，更新favicon
                    if (urlChanged) {
                        updateShortcutFavicon(editIndex, finalUrl);
                    }
                }
            } else {
                const newItem = { name, url: finalUrl };
                if (icon) newItem.icon = icon; // 只有当图标URL存在且非空时才添加
                shortcuts.push(newItem);
                // 保存到localStorage
                localStorage.setItem('shortcuts', JSON.stringify(shortcuts));
                renderShortcuts(); 
            }
            
            editDialog.close();
        }
    });
    
    // 保存搜索引擎对话框
    engineSaveBtn.addEventListener('click', () => {
        const name = engineNameInput.value.trim();
        const url = engineUrlInput.value.trim();
        
        if (name && url) {
            // 检查URL是否包含 %s 占位符
            if (!url.includes('%s')) {
                alert('URL 必须包含 %s 作为搜索词占位符');
                return;
            }
            
            if (isEditing) {
                // 编辑现有搜索引擎
                engines[editIndex] = { name, url };
            } else {
                // 添加新的搜索引擎
                // 使用时间戳生成唯一键，避免名称冲突
                const timestamp = new Date().getTime();
                const randomSuffix = Math.random().toString(36).substring(2, 8);
                const key = `engine_${timestamp}_${randomSuffix}`;
                engines[key] = { name, url };
            }
            
            localStorage.setItem('engines', JSON.stringify(engines));
            renderEngineList();
            updateEngineOptions(); // 更新下拉菜单选项
            engineDialog.close();
            updateEngineSelector();
        }
    });

    cancelBtn.addEventListener('click', () => editDialog.close());
    engineCancelBtn.addEventListener('click', () => engineDialog.close());

    // 更新搜索引擎选择器显示
    function updateEngineSelector() {
        if (engines[preferredEngine]) {
            engineLabel.textContent = engines[preferredEngine].name;
        } else {
            // 如果首选搜索引擎不存在，使用第一个可用的
            const firstEngineKey = Object.keys(engines)[0];
            preferredEngine = firstEngineKey;
            engineLabel.textContent = engines[firstEngineKey].name;
        }
        // 更新下拉菜单选项
        updateEngineOptions();
    }
    
    // 添加搜索引擎拖动事件
    function addEngineDragEvents() {
        const engineItems = document.querySelectorAll('.engine-item');
        
        engineItems.forEach(item => {
            item.addEventListener('dragstart', handleEngineDragStart);
            item.addEventListener('dragover', handleEngineDragOver);
            item.addEventListener('dragenter', handleEngineDragEnter);
            item.addEventListener('dragleave', handleEngineDragLeave);
            item.addEventListener('drop', handleEngineDrop);
            item.addEventListener('dragend', handleEngineDragEnd);
        });
    }
    
    function handleEngineDragStart(e) {
        dragSrcElement = this;
        dragSrcKey = this.dataset.key;
        
        // 设置拖动效果
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', this.innerHTML);
        
        // 添加视觉反馈
        this.classList.add('dragging');
        
        // 在开始拖拽时清除所有元素的 drag-over 样式
        document.querySelectorAll('.engine-item').forEach(item => {
            item.classList.remove('drag-over');
        });
    }
    
    function handleEngineDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        
        // 阻止不必要的操作
        if (this === dragSrcElement) {
            return;
        }
        
        // 获取鼠标位置
        const rect = this.getBoundingClientRect();
        const midpoint = (rect.top + rect.bottom) / 2;
        
        // 根据鼠标位置决定放置在前面还是后面
        if (e.clientY < midpoint) {
            // 插入到当前元素之前
            engineList.insertBefore(dragSrcElement, this);
        } else {
            // 插入到当前元素之后
            engineList.insertBefore(dragSrcElement, this.nextSibling);
        }
        
        return false;
    }
    
    function handleEngineDragEnter(e) {
        e.preventDefault();
        e.stopPropagation();
        // 不再添加 drag-over 样式，保持默认样式
    }
    
    function handleEngineDragLeave(e) {
        // 不需要做任何事，保持默认样式
    }
    
    function handleEngineDrop(e) {
        e.stopPropagation();
        
        // 清除拖拽相关的类
        document.querySelectorAll('.engine-item').forEach(item => {
            item.classList.remove('dragging');
            item.classList.remove('drag-over');
        });
        
        // 拖动结束后，根据DOM顺序更新实际数据
        updateEnginesOrderFromDOM();
        
        return false;
    }
    
    function handleEngineDragEnd(e) {
        // 确保所有拖动相关的类都被清理
        document.querySelectorAll('.engine-item').forEach(item => {
            item.classList.remove('dragging');
            item.classList.remove('drag-over');
        });
    }
    
    // 根据DOM顺序更新搜索引擎实际顺序
    function updateEnginesOrderFromDOM() {
        const engineItems = document.querySelectorAll('.engine-item');
        const newEngineKeys = Array.from(engineItems).map(item => item.dataset.key);
        
        // 创建新的引擎对象，保持DOM中的顺序
        const reorderedEngines = {};
        newEngineKeys.forEach(key => {
            reorderedEngines[key] = engines[key];
        });
        
        // 更新引擎对象
        engines = reorderedEngines;
        
        // 保存到本地存储
        localStorage.setItem('engines', JSON.stringify(engines));
        
        // 更新搜索引擎选择器
        updateEngineSelector();
        updateEngineOptions();
    }
    
    // 重新排列搜索引擎顺序（用于外部调用，如删除时）
    function reorderEngines(fromKey, toKey) {
        // 创建一个新的引擎对象，保持顺序
        const engineKeys = Object.keys(engines);
        const fromIndex = engineKeys.indexOf(fromKey);
        const toIndex = engineKeys.indexOf(toKey);
        
        if (fromIndex !== -1 && toIndex !== -1) {
            // 重新排列数组
            const movedItem = engineKeys.splice(fromIndex, 1)[0];
            engineKeys.splice(toIndex, 0, movedItem);
            
            // 根据新顺序创建新的引擎对象
            const reorderedEngines = {};
            engineKeys.forEach(key => {
                reorderedEngines[key] = engines[key];
            });
            
            // 更新引擎对象
            engines = reorderedEngines;
            
            // 保存到本地存储
            localStorage.setItem('engines', JSON.stringify(engines));
            
            // 重新渲染列表
            renderEngineList();
            
            // 更新搜索引擎选择器
            updateEngineSelector();
            updateEngineOptions();
        }
    }

    // 图片压缩函数
    function compressImage(src, quality = 0.7) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.onload = function() {
                // 创建canvas元素
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // 设置canvas尺寸为原始图片尺寸，但限制最大尺寸
                const maxWidth = 1920;
                const maxHeight = 1080;
                let { width, height } = img;
                
                // 按比例缩放
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
                
                // 在canvas上绘制图片
                ctx.drawImage(img, 0, 0, width, height);
                
                // 转换为Base64格式
                try {
                    const dataURL = canvas.toDataURL('image/jpeg', quality);
                    resolve(dataURL);
                } catch (e) {
                    reject(e);
                }
            };
            img.onerror = function(err) {
                reject(err);
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
            img.onload = function() {
                localStorage.setItem('customBg', compressedImage);
                applyBackground(compressedImage);
            };
            img.src = compressedImage;
        } catch (error) {
            alert('获取图片失败，请重试');
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
        
        // 限制文件大小 (例如 2MB)，防止 localStorage 爆满卡顿
        if (file.size > 5 * 1024 * 1024) {
            alert('图片太大啦，请选择 5MB 以内的图片');
            return;
        }

        const reader = new FileReader();
        reader.onload = async function(event) {
            const base64String = event.target.result;
            try {
                // 压缩图片
                const compressedImage = await compressImage(base64String, 0.7);
                
                // 预加载图片以减少闪烁
                const img = new Image();
                img.onload = function() {
                    localStorage.setItem('customBg', compressedImage);
                    applyBackground(compressedImage);
                };
                img.src = compressedImage;
            } catch (e) {
                alert('存储失败，可能是图片转换后太大了');
            }
        };
        reader.readAsDataURL(file);
    });

    // [背景功能 3] 重置背景
    bgResetBtn.addEventListener('click', () => {
        localStorage.removeItem('customBg');
        localStorage.removeItem('backgroundThemeInfo'); // 同时清除主题信息
        applyBackground('none');
        bgUploadInput.value = ''; // 清空文件 input
    });

    // 数据导出功能
    exportDataBtn.addEventListener('click', () => {
        // 收集所有需要导出的数据
        const exportData = {
            engines: engines,
            preferredEngine: preferredEngine,
            shortcuts: shortcuts,
            gridCols: localStorage.getItem('gridCols') || 5,
            gridSize: localStorage.getItem('gridSize') || 110,
            scale: localStorage.getItem('scale') || 100, // 添加显示比例设置
            customBg: localStorage.getItem('customBg') || null,
            colorMode: localStorage.getItem('colorMode') || 'auto' // 添加颜色模式设置
        };
        
        // 收集所有favicon缓存
        const favicons = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('favicon_')) {
                favicons[key] = localStorage.getItem(key);
            }
        }
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
    importDataInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const importData = JSON.parse(event.target.result);
                
                // 导入数据
                if (importData.engines) {
                    engines = importData.engines;
                    localStorage.setItem('engines', JSON.stringify(engines));
                }
                
                if (importData.preferredEngine) {
                    preferredEngine = importData.preferredEngine;
                    localStorage.setItem('preferredEngine', preferredEngine);
                }
                
                if (importData.shortcuts) {
                    shortcuts = importData.shortcuts;
                    localStorage.setItem('shortcuts', JSON.stringify(shortcuts));
                }
                
                if (importData.gridCols) {
                    localStorage.setItem('gridCols', importData.gridCols);
                }
                
                if (importData.gridSize) {
                    localStorage.setItem('gridSize', importData.gridSize);
                }
                
                // 导入显示比例设置
                if (importData.scale !== undefined) {
                    localStorage.setItem('scale', importData.scale);
                }
                
                if (importData.customBg !== undefined) {
                    if (importData.customBg) {
                        localStorage.setItem('customBg', importData.customBg);
                    } else {
                        localStorage.removeItem('customBg');
                    }
                    localStorage.removeItem('backgroundThemeInfo'); // 清除主题信息
                    applyBackground(importData.customBg || null);
                }
                
                // 导入颜色模式设置
                if (importData.colorMode !== undefined) {
                    localStorage.setItem('colorMode', importData.colorMode);
                }
                
                // 导入favicon缓存
                if (importData.favicons) {
                    // 清除现有的favicon缓存
                    Object.keys(localStorage).forEach(key => {
                        if (key.startsWith('favicon_')) {
                            localStorage.removeItem(key);
                        }
                    });
                    
                    // 导入新的favicon缓存
                    Object.keys(importData.favicons).forEach(key => {
                        localStorage.setItem(key, importData.favicons[key]);
                    });
                }
                
                // 更新UI
                document.documentElement.style.setProperty('--col-count', localStorage.getItem('gridCols') || 5);
                document.documentElement.style.setProperty('--item-size', `${localStorage.getItem('gridSize') || 110}px`);
                document.documentElement.style.setProperty('--scale', (localStorage.getItem('scale') || 100) / 100);
                colInput.value = localStorage.getItem('gridCols') || 5;
                colValDisplay.innerText = localStorage.getItem('gridCols') || 5;
                sizeInput.value = localStorage.getItem('gridSize') || 110;
                scaleInput.value = localStorage.getItem('scale') || 100;
                scaleValDisplay.innerText = (localStorage.getItem('scale') || 100) + '%';
                
                // 更新颜色模式按钮状态
                document.querySelectorAll('.color-mode-buttons .glass-btn').forEach(btn => {
                    btn.classList.remove('active');
                });
                const savedColorMode = localStorage.getItem('colorMode') || 'auto';
                document.querySelector(`.color-mode-buttons .glass-btn[data-mode="${savedColorMode}"]`).classList.add('active');
                
                updateEngineSelector();
                renderEngineList();
                renderShortcuts();
                
                alert('数据导入成功！');
            } catch (error) {
                console.error('导入数据时出错:', error);
                alert('导入数据失败，请确保选择了有效的JSON文件。');
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
            // 获取首选搜索引擎的URL
            const engine = engines[preferredEngine];
            if (engine) {
                const searchUrl = engine.url.replace('%s', encodeURIComponent(query));
                window.location.href = searchUrl;
            }
        }
    }
    
    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') performSearch(); });

    // --- 4. 快捷方式渲染 ---
    function renderShortcuts() {
        grid.innerHTML = '';
        shortcuts.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'shortcut-item glass-element';
            div.draggable = true;
            div.dataset.index = index;
            
            // 使用自定义图标或获取网站favicon
            let faviconUrl = item.icon;
            if (!faviconUrl) {
                // 尝试从本地存储获取favicon
                const hostname = new URL(getFullUrl(item.url)).hostname;
                const savedFavicon = localStorage.getItem(`favicon_${hostname}`);
                if (savedFavicon) {
                    faviconUrl = savedFavicon;
                } else {
                    // 只有在支持background script的情况下才尝试获取favicon
                    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
                        // 异步获取favicon并缓存
                        getFaviconAndCache(item.url, div);
                        // 使用Google服务作为临时图标直到获取完成
                        faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
                    } else {
                        // 如果不支持background script，直接使用Google服务图标
                        faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
                    }
                }
            }
            
            div.innerHTML = `<img src="${faviconUrl}" alt="${item.name}"><span title="${item.name}">${item.name}</span>`;
            div.addEventListener('click', (e) => { if(!e.defaultPrevented) window.location.href = item.url; });
            div.addEventListener('contextmenu', (e) => showContextMenu(e, index));
            addDragEvents(div);
            grid.appendChild(div);
        });
        localStorage.setItem('shortcuts', JSON.stringify(shortcuts));
    }
    
    // 辅助函数：确保URL有协议前缀
    function getFullUrl(url) {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return 'https://' + url;
        }
        return url;
    }
    
    // 获取网站favicon并缓存到localStorage
    async function getFaviconAndCache(websiteUrl, element) {
        // 首先检查是否有本地缓存（使用与renderShortcuts中相同的键）
        const hostname = new URL(getFullUrl(websiteUrl)).hostname;
        const cacheKey = `favicon_${hostname}`;
        const savedFavicon = localStorage.getItem(cacheKey);
        if (savedFavicon) {
            // 如果有缓存，直接使用，不尝试网络请求
            if (element && element.querySelector) {
                const img = element.querySelector('img');
                if (img) {
                    img.src = savedFavicon;
                }
            }
            return;
        }
        
        // 检查是否可以使用background script
        if (!(chrome && chrome.runtime && chrome.runtime.sendMessage)) {
            console.log('Background script不可用，跳过favicon获取');
            return;
        }
        
        const fullUrl = getFullUrl(websiteUrl);
        const hostnameFavicon = new URL(fullUrl).hostname;
        
        try {
            // 按优先级尝试不同的favicon源
            const faviconUrls = [
                `${fullUrl}/favicon.png`,
                `${fullUrl}/favicon.ico`,
                `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`,
            ];
            
            // 逐个尝试favicon源
            let success = false;
            for (let i = 0; i < faviconUrls.length; i++) {
                try {
                    let dataUrl;
                    
                    // 使用background script获取favicon
                    const response = await chrome.runtime.sendMessage({
                        action: "fetchFavicon",
                        url: faviconUrls[i]
                    });
                    
                    if (response.success) {
                        dataUrl = response.dataUrl;
                    } else {
                        throw new Error(response.error || "Unknown error");
                    }
                    
                    // 检查是否是有效的图标数据
                    if (dataUrl && dataUrl.length > 0) {
                        try {
                            localStorage.setItem(cacheKey, dataUrl);
                        } catch (storageError) {
                            console.warn('无法缓存favicon，可能是因为存储空间不足');
                            
                            // 如果是存储空间不足，尝试清理旧的favicon缓存
                            if (storageError.name === 'QuotaExceededError') {
                                try {
                                    // 清理所有favicon缓存
                                    Object.keys(localStorage).forEach(key => {
                                        if (key.startsWith('favicon_')) {
                                            localStorage.removeItem(key);
                                        }
                                    });
                                    
                                    // 重新尝试存储
                                    localStorage.setItem(cacheKey, dataUrl);
                                } catch (retryError) {
                                    console.error('清理缓存后仍无法存储favicon:', retryError);
                                }
                            }
                        }
                        
                        // 更新页面上的图标
                        if (element && element.querySelector) {
                            const img = element.querySelector('img');
                            if (img) {
                                img.src = dataUrl;
                            }
                        }
                        
                        success = true;
                        break;
                    }
                } catch (error) {
                    // 忽略单个请求的错误，继续尝试下一个源
                    console.warn(`无法从 ${faviconUrls[i]} 获取favicon:`, error.message);
                }
            }
            
            if (!success) {
                console.warn(`无法获取 ${websiteUrl} 的favicon`);
            }
        } catch (error) {
            console.error('获取favicon时出错:', error);
        }
    }
    
    // 将Blob转换为Data URL
    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    
    // 当用户编辑快捷方式URL时，清除旧的favicon缓存并获取新的favicon
    function updateShortcutFavicon(index, newUrl) {
        // 获取旧的URL来删除对应的favicon缓存
        const oldUrl = shortcuts[index].url;
        const oldHostname = new URL(getFullUrl(oldUrl)).hostname;
        
        // 清除旧的favicon缓存
        localStorage.removeItem(`favicon_${oldHostname}`);
        
        // 重新渲染快捷方式以获取新favicon
        setTimeout(() => {
            const shortcutElements = document.querySelectorAll('.shortcut-item');
            if (shortcutElements[index]) {
                getFaviconAndCache(newUrl, shortcutElements[index]);
            }
        }, 100);
    }
    
    // 页面加载完成后渲染快捷方式
    renderShortcuts();
    
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
    
    function addDragEvents(item) {
        item.addEventListener('dragstart', (e) => {
            dragStartIndex = parseInt(item.dataset.index);
            currentDragElement = item;
            item.classList.add('dragging');
            item.style.opacity = '0.5';
            
            // 设置拖拽数据
            e.dataTransfer.setData('text/plain', item.dataset.index);
            e.dataTransfer.effectAllowed = 'move';
            
            // 每次开始拖拽时重置位置状态
            lastInsertPosition = null;
            
            // 清理所有快捷方式的hover状态
            const allShortcuts = grid.querySelectorAll('.shortcut-item');
            allShortcuts.forEach(shortcut => {
                if (shortcut !== currentDragElement) {
                    shortcut.classList.remove('hover');
                }
            });
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        
        // 用于跟踪上一个目标元素，以避免重复触发
        let lastTargetElement = null;
        
        item.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // 只有当不是从自身拖拽到自身时才重新排列
            if (currentDragElement !== item) {
                const fromIndex = dragStartIndex;
                const toIndex = parseInt(item.dataset.index);
                
                if (fromIndex !== toIndex) {
                    // 记录插入位置，避免重复操作
                    const insertPosition = `${fromIndex}-${toIndex}`;
                    if (lastInsertPosition === insertPosition) {
                        return;
                    }
                    lastInsertPosition = insertPosition;
                    
                    // 直接操作DOM元素位置，不修改数据
                    if (fromIndex < toIndex) {
                        // 向后移动
                        item.parentNode.insertBefore(currentDragElement, item.nextSibling);
                    } else {
                        // 向前移动
                        item.parentNode.insertBefore(currentDragElement, item);
                    }
                    
                    // 更新起始索引
                    dragStartIndex = toIndex;
                }
            }
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // 只有当不是从自身拖拽到自身时才重新排列
            if (currentDragElement !== item) {
                const fromIndex = dragStartIndex;
                const toIndex = parseInt(item.dataset.index);
                
                if (fromIndex !== toIndex) {
                    // 记录插入位置，避免重复操作
                    const insertPosition = `${fromIndex}-${toIndex}`;
                    if (lastInsertPosition === insertPosition) {
                        return;
                    }
                    lastInsertPosition = insertPosition;
                    
                    // 直接操作DOM元素位置，不修改数据
                    if (fromIndex < toIndex) {
                        // 向后移动
                        item.parentNode.insertBefore(currentDragElement, item.nextSibling);
                    } else {
                        // 向前移动
                        item.parentNode.insertBefore(currentDragElement, item);
                    }
                    
                    // 更新起始索引
                    dragStartIndex = toIndex;
                }
            }
        });
        
        item.addEventListener('dragleave', (e) => {
            // 不需要在这里做任何事情
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        
        item.addEventListener('dragend', () => {
            // 拖拽结束后，根据DOM顺序重建数据
            const shortcutItems = grid.querySelectorAll('.shortcut-item');
            const newShortcuts = [];
            
            shortcutItems.forEach((shortcutItem, index) => {
                const itemIndex = parseInt(shortcutItem.dataset.index);
                newShortcuts.push(shortcuts[itemIndex]);
                // 更新索引
                shortcutItem.dataset.index = index;
            });
            
            // 更新数据模型
            shortcuts = newShortcuts;
            
            // 保存到localStorage
            localStorage.setItem('shortcuts', JSON.stringify(shortcuts));
            
            // 清理样式
            if (currentDragElement) {
                currentDragElement.classList.remove('dragging');
                currentDragElement.style.opacity = '';
            }
            currentDragElement = null;
            lastInsertPosition = null;
            
            // 清理所有快捷方式的hover状态
            const allShortcuts = grid.querySelectorAll('.shortcut-item');
            allShortcuts.forEach(shortcut => {
                shortcut.classList.remove('hover');
            });
        });
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
            alert('请选择图片文件');
            return;
        }
        
        // 限制文件大小 (例如 500KB)
        if (file.size > 500 * 1024) {
            alert('图片太大啦，请选择 500KB 以内的图片');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(event) {
            iconInput.value = event.target.result;
        };
        reader.readAsDataURL(file);
    });
    
    cancelBtn.addEventListener('click', () => editDialog.close());

    // 初始化右键菜单颜色模式
    function initContextMenuColorMode() {
        // 这个函数现在不需要了，因为我们已经在updateTextColorClasses函数中处理了右键菜单的颜色
    }
    
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
    
    // 应用存储的主题
    function applyStoredTheme(theme) {
        const body = document.body;
        body.classList.remove('light-bg');
        
        // 使用存储的主题
        // 不再添加light-bg类，避免影响页面元素
        
        // 更新文本颜色类
        updateTextColorClasses(theme);
        
        // 更新对话框颜色模式
        updateDialogColorMode(theme);
    }
    
    // 应用颜色模式
    function applyColorMode(mode) {
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
                const themeInfo = localStorage.getItem('backgroundThemeInfo');
                currentTheme = themeInfo ? JSON.parse(themeInfo).theme : 'dark';
                break;
        }
        
        // 只更新快捷方式和搜索框的颜色类
        updateTextColorClasses(currentTheme);
        
        // 更新对话框的颜色模式
        updateDialogColorMode(currentTheme);
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
                // 创建canvas来分析图片
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);
                
                // 获取图片中心1/3区域的像素数据
                const centerX = Math.floor(img.width / 2);
                const centerY = Math.floor(img.height / 2);
                const sampleWidth = Math.floor(img.width / 3);
                const sampleHeight = Math.floor(img.height / 3);
                const startX = centerX - Math.floor(sampleWidth / 2);
                const startY = centerY - Math.floor(sampleHeight / 2);
                
                const imageData = ctx.getImageData(startX, startY, sampleWidth, sampleHeight);
                const data = imageData.data;
                
                // 计算平均亮度
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
                
                // 根据平均亮度设置主题
                if (averageBrightness > 128) {
                    theme = 'light';
                    // 不添加light-bg类，只更新文字和图标颜色
                }
                
                // 存储主题信息和相关上下文
                const themeInfo = {
                    theme: theme,
                    bgUrl: bgUrl,
                    systemTheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
                };
                localStorage.setItem('backgroundThemeInfo', JSON.stringify(themeInfo));
                
                // 更新快捷方式和搜索框的颜色类
                updateTextColorClasses(theme);
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
                localStorage.setItem('backgroundThemeInfo', JSON.stringify(themeInfo));
                
                // 更新快捷方式和搜索框的颜色类
                updateTextColorClasses(theme);
            }
        }
    }
    
    // 更新文本颜色类
    function updateTextColorClasses(mode) {
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
            const themeInfo = localStorage.getItem('backgroundThemeInfo');
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
    setTimeout(() => {
        const savedColorMode = localStorage.getItem('colorMode') || 'auto';
        let currentTheme;
        
        if (savedColorMode === 'auto') {
            const themeInfo = localStorage.getItem('backgroundThemeInfo');
            currentTheme = themeInfo ? JSON.parse(themeInfo).theme : 'dark';
        } else {
            currentTheme = savedColorMode;
        }
        
        updateTextColorClasses(currentTheme);
    }, 0);
    
    // 更新对话框颜色模式
    function updateDialogColorMode(mode) {
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
                const themeInfo = localStorage.getItem('backgroundThemeInfo');
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
    renderEngineList();
});