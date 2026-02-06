// Config management
const CONFIG_KEY = 'aigpic.config_name';
let availableConfigs = [];
let defaultConfigName = '';

let currentPage = 1;
const pageSize = 16;
let totalPages = 1;
let ws = null;
let isGenerating = false;
let taskTimer = null;
let previewImages = [];
let previewIndex = -1;
const NOTICE_DURATION = 3000;
let uploadedImageData = null;
let previousCount = 1;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
let isTasksExpanded = false; // Task list expand state
let tasksDataMap = new Map(); // Store task data in memory
let allTasks = []; // Store all loaded tasks

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadImages();
    connectWebSocket();
    loadConfigOptions();
});

// Event Listeners
function setupEventListeners() {
    document.getElementById('configSelect').addEventListener('change', (event) => {
        persistConfigSelection(event.target.value);
    });

    // Generate button
    document.getElementById('generateBtn').addEventListener('click', generateImages);

    // Image upload
    document.getElementById('attachBtn').addEventListener('click', handleAttachClick);
    document.getElementById('imageInput').addEventListener('change', handleImageSelect);
    document.getElementById('removeImageBtn').addEventListener('click', removeImage);

    // Preview navigation
    document.getElementById('previewPrev').addEventListener('click', (event) => {
        event.stopPropagation();
        showPrevImage();
    });
    document.getElementById('previewNext').addEventListener('click', (event) => {
        event.stopPropagation();
        showNextImage();
    });

    // Pagination
    document.getElementById('prevPage').addEventListener('click', () => changePage(-1));
    document.getElementById('nextPage').addEventListener('click', () => changePage(1));

    // Modal close buttons
    document.querySelectorAll('.close').forEach(btn => {
        btn.addEventListener('click', closeModals);
    });

    // Close modal when clicking outside
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            closeModals();
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
}

// Config functions
async function loadConfigOptions() {
    try {
        const response = await fetch('/api/configs');
        if (!response.ok) {
            throw new Error('无法加载配置列表');
        }

        const data = await response.json();
        availableConfigs = Array.isArray(data.configs) ? data.configs : [];
        defaultConfigName = data.default || (availableConfigs[0] ? availableConfigs[0].name : '');

        const storedName = getStoredConfigName();
        const selectedName = availableConfigs.some(config => config.name === storedName)
            ? storedName
            : defaultConfigName;

        setConfigOptions(availableConfigs, selectedName);
    } catch (error) {
        console.error('Failed to load configs:', error);
        setConfigOptions([], '');
    }
}

function setConfigOptions(configs, selectedName) {
    const select = document.getElementById('configSelect');
    select.innerHTML = configs.length
        ? configs.map(config => `<option value="${config.name}">${config.name}</option>`).join('')
        : '<option value="">无可用配置</option>';

    if (selectedName) {
        select.value = selectedName;
        persistConfigSelection(selectedName);
    }
}

function getStoredConfigName() {
    return localStorage.getItem(CONFIG_KEY);
}

function getSelectedConfigName() {
    const select = document.getElementById('configSelect');
    if (select && select.value) {
        return select.value;
    }
    return getStoredConfigName() || '';
}

function persistConfigSelection(name) {
    if (name) {
        localStorage.setItem(CONFIG_KEY, name);
    }
}

function getSelectedRatio() {
    const selected = document.querySelector('input[name="ratio"]:checked');
    return selected ? selected.value : 'default';
}

function showNotice(message, options = {}) {
    const container = document.getElementById('noticeContainer');
    if (!container) {
        return;
    }

    const notice = document.createElement('div');
    notice.className = 'notice';

    const text = document.createElement('span');
    text.className = 'notice-text';
    text.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'notice-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => removeNotice(notice));

    notice.appendChild(text);
    notice.appendChild(closeBtn);
    container.appendChild(notice);

    if (options.autoClose !== false) {
        const duration = Number.isFinite(options.duration) ? options.duration : NOTICE_DURATION;
        if (duration > 0) {
            notice._timeoutId = setTimeout(() => removeNotice(notice), duration);
        }
    }
}

function removeNotice(notice) {
    if (!notice) {
        return;
    }
    if (notice._timeoutId) {
        clearTimeout(notice._timeoutId);
    }
    notice.remove();
}

function ensureTaskTimer() {
    if (taskTimer) {
        return;
    }
    taskTimer = setInterval(updateTaskTimers, 1000);
}

function updateTaskTimers() {
    const items = document.querySelectorAll('.task-item');
    items.forEach(item => {
        const taskId = item.dataset.taskId;
        const taskData = tasksDataMap.get(taskId);
        if (!taskData) {
            return;
        }

        const status = taskData.status;
        const statusEl = item.querySelector('.task-status');
        if (!statusEl) {
            return;
        }

        const startedAt = taskData.started_at || taskData.created_at;
        const finishedAt = taskData.finished_at;
        const duration = getDurationSeconds(startedAt, status === 'running' ? null : finishedAt);
        const durationText = duration !== null ? `${duration}秒` : '';

        if (status === 'running') {
            statusEl.textContent = durationText ? `生成中(${durationText})` : '生成中';
        } else if (status === 'succeeded') {
            statusEl.textContent = durationText ? `已完成(${durationText})` : '已完成';
        } else if (status === 'failed') {
            statusEl.textContent = durationText ? `失败(${durationText})` : '失败';
        } else if (status === 'queued') {
            statusEl.textContent = '排队中';
        }
    });
}

function getDurationSeconds(startedAt, finishedAt) {
    if (!startedAt) {
        return null;
    }
    const startTime = Date.parse(startedAt);
    if (Number.isNaN(startTime)) {
        return null;
    }
    const endTime = finishedAt ? Date.parse(finishedAt) : Date.now();
    if (Number.isNaN(endTime)) {
        return null;
    }
    return Math.max(0, Math.floor((endTime - startTime) / 1000));
}

function closeModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.style.display = 'none';
    });
}

// Keyboard shortcuts handler
function handleKeyboardShortcuts(e) {
    // Check if preview modal is open
    const previewModal = document.getElementById('previewModal');
    const isPreviewOpen = previewModal && previewModal.style.display === 'block';

    if (isPreviewOpen) {
        // In preview mode
        switch(e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                showPrevImage();
                break;
            case 'ArrowRight':
                e.preventDefault();
                showNextImage();
                break;
            case 'Escape':
                e.preventDefault();
                closeModals();
                break;
        }
    } else {
        // Not in preview mode - handle pagination
        // Don't trigger if user is typing in an input field
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        switch(e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                const prevBtn = document.getElementById('prevPage');
                if (prevBtn && !prevBtn.disabled) {
                    prevBtn.click();
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                const nextBtn = document.getElementById('nextPage');
                if (nextBtn && !nextBtn.disabled) {
                    nextBtn.click();
                }
                break;
        }
    }
}

// WebSocket connection
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/tasks`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'initial_tasks') {
            renderTasks(data.tasks);
        } else if (data.type === 'task_update') {
            updateTask(data.task);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };
}

async function updateTask(task) {
    // Fetch latest tasks from server (always fetch 15 tasks)
    try {
        const response = await fetch('/api/tasks?limit=15');
        if (response.ok) {
            const tasks = await response.json();
            renderTasks(tasks);
        }
    } catch (error) {
        console.error('Failed to fetch tasks:', error);
    }

    // If task succeeded, refresh images
    if (task.status === 'succeeded') {
        loadImages();
    }
}

// Generate images
async function generateImages() {
    if (isGenerating) return;

    const prompt = document.getElementById('prompt').value.trim();
    const count = parseInt(document.getElementById('count').value);
    const configName = getSelectedConfigName();
    const ratio = getSelectedRatio();

    // Validation
    if (!prompt) {
        showNotice('请输入提示词');
        return;
    }

    if (!configName) {
        showNotice('请先选择配置');
        const select = document.getElementById('configSelect');
        if (select) {
            select.focus();
        }
        return;
    }

    if (count < 1 || count > 10) {
        showNotice('生成数量必须在 1-10 之间');
        return;
    }

    // Force count to 1 if image is uploaded
    if (uploadedImageData && count !== 1) {
        count = 1;
    }

    // Set button to loading state
    const btn = document.getElementById('generateBtn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<span class="btn-label">Loading...</span>';
    btn.disabled = true;
    isGenerating = true;

    const promptWithRatio = ratio === 'default' ? prompt : `${prompt} 宽高比例为${ratio}`;

    try {
        const response = await fetch('/api/tasks', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: promptWithRatio,
                n: count,
                config_name: configName,
                image_data: uploadedImageData
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || '创建任务失败');
        }

        const data = await response.json();
        console.log(`任务已创建: ${data.task_id}`);

        // Don't clear prompt - keep it for user

    } catch (error) {
        showNotice(`错误: ${error.message}`);
    } finally {
        // Restore button state
        btn.innerHTML = originalContent;
        btn.disabled = false;
        isGenerating = false;
    }
}

// Task management
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderTasks(tasks) {
    const container = document.getElementById('tasksList');

    if (!tasks || tasks.length === 0) {
        container.innerHTML = '<p style="color: #999;">暂无任务</p>';
        return;
    }

    // Store all tasks
    allTasks = tasks;

    // Clear previous task data
    tasksDataMap.clear();

    // Sort tasks: running tasks first, then by creation time (newest first)
    const sortedTasks = [...tasks].sort((a, b) => {
        // Running tasks always come first
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;

        // Within same status group, sort by creation time (newest first)
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA;
    });

    // Determine how many tasks to show
    const maxTasks = isTasksExpanded ? 15 : 3;
    const displayTasks = sortedTasks.slice(0, maxTasks);
    const hasMore = sortedTasks.length > 3;

    const tasksHtml = displayTasks.map(task => {
        const statusText = getTaskStatusText(task);

        // Use full prompt, no truncation
        const displayPrompt = formatTaskPrompt(task.prompt);

        const taskId = task.task_id || '';

        // Store task data in memory (store all tasks, not just displayed ones)
        tasksDataMap.set(taskId, {
            status: task.status,
            started_at: task.started_at || '',
            finished_at: task.finished_at || '',
            created_at: task.created_at || '',
            error: task.error || '',
            prompt: task.prompt
        });

        // All tasks are clickable
        const clickHandler = `onclick="showTaskDetail('${escapeHtml(taskId)}')"`;

        return `
            <div class="task-item ${task.status}"
                 data-task-id="${escapeHtml(taskId)}"
                 ${clickHandler}
                 style="cursor: pointer;"
                 title="${escapeHtml(displayPrompt)}">
                <span class="task-prompt">${displayPrompt}</span>
                <span class="task-status">${statusText}</span>
            </div>
        `;
    }).join('');

    // Store all tasks data in memory
    sortedTasks.forEach(task => {
        const taskId = task.task_id || '';
        if (!tasksDataMap.has(taskId)) {
            tasksDataMap.set(taskId, {
                status: task.status,
                started_at: task.started_at || '',
                finished_at: task.finished_at || '',
                created_at: task.created_at || '',
                error: task.error || '',
                prompt: task.prompt
            });
        }
    });

    // Add expand/collapse button if there are more than 3 tasks
    const toggleButton = hasMore ? `
        <div style="text-align: center; margin-top: 10px;">
            <button id="toggleTasksBtn" class="toggle-tasks-btn" onclick="toggleTasksExpand()">
                ${isTasksExpanded ? '收起' : '展开更多'}
            </button>
        </div>
    ` : '';

    container.innerHTML = tasksHtml + toggleButton;

    ensureTaskTimer();
    updateTaskTimers();
}

function toggleTasksExpand() {
    isTasksExpanded = !isTasksExpanded;
    // Re-render with existing tasks data (no backend request)
    renderTasks(allTasks);
}

function getTaskStatusText(task) {
    const duration = getDurationSeconds(
        task.started_at || task.created_at,
        task.status === 'running' ? null : task.finished_at
    );
    const durationText = duration !== null ? `${duration}秒` : '';

    if (task.status === 'running') {
        return durationText ? `生成中(${durationText})` : '生成中';
    }
    if (task.status === 'succeeded') {
        return durationText ? `已完成(${durationText})` : '已完成';
    }
    if (task.status === 'failed') {
        return durationText ? `失败(${durationText})` : '失败';
    }
    if (task.status === 'queued') {
        return '排队中';
    }
    return task.status || '';
}

function formatTaskPrompt(prompt) {
    if (!prompt) {
        return '';
    }
    return prompt.replace(/\s+宽高比例为(9:16|16:9|4:3|1:1)$/, '');
}

// Image management
async function loadImages() {
    try {
        const response = await fetch(`/api/images?page=${currentPage}&page_size=${pageSize}`);
        if (!response.ok) return;

        const data = await response.json();
        renderImages(data);
    } catch (error) {
        console.error('Failed to load images:', error);
    }
}

function renderImages(data) {
    const grid = document.getElementById('imagesGrid');
    const pageInfo = document.getElementById('pageInfo');

    if (data.items.length === 0) {
        grid.innerHTML = '<p style="color: #999; grid-column: 1/-1; text-align: center;">暂无图片</p>';
        pageInfo.textContent = '0 / 0';
        previewImages = [];
        previewIndex = -1;
        return;
    }

    previewImages = data.items.map(img => img.url);

    grid.innerHTML = data.items.map(img => `
        <div class="image-item" onclick="previewImage('${img.url}')">
            <img src="${img.url}" alt="Generated image">
            <button class="delete-btn" onclick="event.stopPropagation(); deleteImage(${img.id})" title="删除">×</button>
            <div class="image-actions">
                <button class="action-btn" onclick="event.stopPropagation(); showPrompt(${img.id})" title="查看提示词">
                    ℹ️
                </button>
                <button class="action-btn" onclick="event.stopPropagation(); useImageAsAttachment('${img.url}')" title="作为附件">
                    📎
                </button>
            </div>
        </div>
    `).join('');

    const totalPages = Math.ceil(data.total / pageSize);
    pageInfo.textContent = `${currentPage} / ${totalPages}`;

    document.getElementById('prevPage').disabled = currentPage === 1;
    document.getElementById('nextPage').disabled = currentPage >= totalPages;
}

function changePage(delta) {
    currentPage += delta;
    if (currentPage < 1) currentPage = 1;
    loadImages();
}

function previewImage(url) {
    document.getElementById('previewImage').src = url;
    document.getElementById('previewModal').style.display = 'block';
    previewIndex = previewImages.indexOf(url);
}

function showPrevImage() {
    if (previewIndex <= 0) {
        showNotice('已经是最后一张了');
        return;
    }
    previewIndex -= 1;
    document.getElementById('previewImage').src = previewImages[previewIndex];
}

function showNextImage() {
    if (previewIndex === -1 || previewIndex >= previewImages.length - 1) {
        showNotice('已经是最后一张了');
        return;
    }
    previewIndex += 1;
    document.getElementById('previewImage').src = previewImages[previewIndex];
}

async function showPrompt(imageId) {
    try {
        const response = await fetch(`/api/images/${imageId}/prompt`);
        if (!response.ok) throw new Error('获取提示词失败');

        const data = await response.json();
        document.getElementById('promptText').textContent = data.prompt;
        document.getElementById('promptModal').style.display = 'block';
    } catch (error) {
        showNotice(`错误: ${error.message}`);
    }
}

async function deleteImage(imageId) {
    if (!confirm('确定要删除这张图片吗？')) return;

    try {
        const response = await fetch(`/api/images/${imageId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('删除失败');

        loadImages();
    } catch (error) {
        showNotice(`错误: ${error.message}`);
    }
}

// Image upload functions
function handleAttachClick() {
    document.getElementById('imageInput').click();
}

async function handleImageSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate image
    const validation = validateImage(file);
    if (!validation.valid) {
        showNotice(validation.error);
        event.target.value = '';
        return;
    }

    try {
        const dataUrl = await readImageAsDataURL(file);
        uploadedImageData = dataUrl;
        showImageThumbnail(dataUrl);
        updateCountInputState();
    } catch (error) {
        showNotice(`读取图片失败: ${error.message}`);
        event.target.value = '';
    }
}

function validateImage(file) {
    // Check type
    if (!file.type.startsWith('image/')) {
        return { valid: false, error: '仅支持图片格式' };
    }

    // Check size
    if (file.size > MAX_IMAGE_SIZE) {
        return { valid: false, error: `图片大小不能超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB` };
    }

    return { valid: true };
}

function readImageAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

function showImageThumbnail(dataUrl) {
    const container = document.querySelector('.prompt-container');
    const thumbnail = document.getElementById('imageThumbnail');
    const img = document.getElementById('thumbnailImg');

    container.classList.add('has-image');
    thumbnail.style.display = 'block';
    img.src = dataUrl;
}

function removeImage() {
    const container = document.querySelector('.prompt-container');
    const thumbnail = document.getElementById('imageThumbnail');
    const input = document.getElementById('imageInput');

    uploadedImageData = null;
    container.classList.remove('has-image');
    thumbnail.style.display = 'none';
    input.value = '';

    updateCountInputState();
}

function updateCountInputState() {
    const countInput = document.getElementById('count');
    const ratioSection = document.querySelector('.ratio-section');
    const countSection = document.querySelector('.count-section');
    const hasImage = uploadedImageData !== null;

    if (hasImage) {
        // Save current count before disabling
        previousCount = parseInt(countInput.value) || 1;
        countInput.value = 1;
        countInput.disabled = true;

        // Hide ratio and count sections
        if (ratioSection) ratioSection.style.display = 'none';
        if (countSection) countSection.style.display = 'none';
    } else {
        // Restore previous count
        countInput.value = previousCount;
        countInput.disabled = false;

        // Show ratio and count sections
        if (ratioSection) ratioSection.style.display = 'block';
        if (countSection) countSection.style.display = 'block';
    }
}

// Task detail display
function showTaskDetail(taskId) {
    // Get task data from memory
    const taskData = tasksDataMap.get(taskId);
    if (!taskData) {
        showNotice('任务不存在');
        return;
    }

    // Display prompt
    document.getElementById('taskDetailPrompt').textContent = taskData.prompt;

    // Display status
    const statusMap = {
        'running': '生成中',
        'succeeded': '已完成',
        'failed': '失败',
        'queued': '排队中'
    };
    document.getElementById('taskDetailStatus').textContent = statusMap[taskData.status] || taskData.status;

    // Display error if failed
    const errorSection = document.getElementById('taskDetailErrorSection');
    if (taskData.status === 'failed' && taskData.error) {
        document.getElementById('taskDetailError').textContent = taskData.error;
        errorSection.style.display = 'block';
    } else {
        errorSection.style.display = 'none';
    }

    // Show modal
    document.getElementById('taskDetailModal').style.display = 'block';
}

// Use image as attachment
async function useImageAsAttachment(imageUrl) {
    try {
        // Fetch image from URL
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error('图片加载失败');
        }

        const blob = await response.blob();

        // Convert blob to data URL
        const reader = new FileReader();
        reader.onload = function(e) {
            uploadedImageData = e.target.result;
            showImageThumbnail(uploadedImageData);
            updateCountInputState();
            showNotice('已将图片设为附件');
        };
        reader.onerror = function() {
            showNotice('图片读取失败');
        };
        reader.readAsDataURL(blob);
    } catch (error) {
        showNotice(`设置附件失败: ${error.message}`);
    }
}
