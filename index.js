/* SillyTavern / SillyDroid Intiface Safe Sequence
 * Local safety-focused replacement for the community ST-Intiface-Plugin.
 * Supports multiple ordered <toy ... /> steps in one completed AI reply.
 */
(() => {
    'use strict';

    const PLUGIN_NAME = 'IntifaceSafeSequence';
    const PLUGIN_VERSION = '1.1.0-safe';
    const SETTINGS_KEY = 'intiface_safe_sequence_settings';

    // Hard safety limits: these are enforced in code, not supplied by the model.
    const LIMITS = Object.freeze({
        defaultIntensity: 0.10,
        maxIntensity: 0.20,
        defaultDurationMs: 1000,
        minDurationMs: 250,
        maxDurationMs: 2000,
        maxActionsPerReply: 8,
        maxTotalDurationMs: 10000,
        gapBetweenActionsMs: 300,
    });

    const DEFAULT_SETTINGS = Object.freeze({
        serverAddress: 'ws://192.168.31.19:12345',
        enabled: false,
        autoConnect: false,
    });

    let settings = { ...DEFAULT_SETTINGS };
    let ws = null;
    let connected = false;
    let serverReady = false;
    let devices = new Map();
    let nextId = 1;
    const pending = new Map();
    let currentRunId = 0;
    let lastProcessedKey = '';
    let getContextFn = null;
    let eventSource = null;
    let eventTypes = null;
    let fallbackTimer = null;
    let fallbackLastText = '';
    let fallbackStableSince = 0;
    let skipNextGenerationEnd = false;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const finiteNumber = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };

    function log(message, level = 'info') {
        const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const line = `[${stamp}] ${message}`;
        if (level === 'error') console.error(`[Intiface Safe] ${line}`);
        else if (level === 'warn') console.warn(`[Intiface Safe] ${line}`);
        else console.log(`[Intiface Safe] ${line}`);

        const box = $('#ifs-log');
        if (box.length) {
            const color = level === 'error' ? '#ff7777' : level === 'warn' ? '#ffd166' : '#8ee6a8';
            $('<div>').text(line).css({ color, padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }).appendTo(box);
            while (box.children().length > 50) box.children().first().remove();
            box.scrollTop(box[0].scrollHeight);
        }
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    }

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            settings = { ...DEFAULT_SETTINGS, ...saved };
        } catch (_) {
            settings = { ...DEFAULT_SETTINGS };
        }
        // Never load model-adjustable or legacy strength/duration settings.
        settings.serverAddress = String(settings.serverAddress || DEFAULT_SETTINGS.serverAddress);
        settings.enabled = settings.enabled === true;
        settings.autoConnect = settings.autoConnect === true;
    }

    function initUI() {
        const html = `
        <div class="inline-drawer" id="intiface-safe-sequence-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>玩具控制器 · 安全序列版 <span style="font-size:11px;opacity:.6">v${PLUGIN_VERSION}</span></b>
            <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content" style="display:none">
            <div class="if-body">
              <div class="if-section">
                <div class="if-section-title">连接管理</div>
                <div class="if-connection-row">
                  <span class="if-status-dot" id="ifs-status-dot"></span>
                  <span class="if-status-text" id="ifs-status-text">未连接</span>
                </div>
                <input class="if-input" id="ifs-server-address" value="${settings.serverAddress}" />
                <div class="if-btn-group">
                  <button class="if-btn if-btn-primary" id="ifs-connect">连接</button>
                  <button class="if-btn if-btn-danger" id="ifs-disconnect" style="display:none">断开</button>
                </div>
                <div id="ifs-devices" style="margin-top:10px;font-size:13px">尚未发现设备</div>
              </div>
              <div class="if-section">
                <div class="if-section-title">AI 自动控制</div>
                <div class="if-setting-row">
                  <span>启用解析自动控制</span>
                  <input type="checkbox" id="ifs-enabled" ${settings.enabled ? 'checked' : ''}/>
                </div>
                <div class="if-setting-row">
                  <span>启动时自动连接</span>
                  <input type="checkbox" id="ifs-autoconnect" ${settings.autoConnect ? 'checked' : ''}/>
                </div>
                <div style="font-size:12px;line-height:1.6;opacity:.85">
                  每条 AI 回复最多 ${LIMITS.maxActionsPerReply} 个动作；单动作最长 ${LIMITS.maxDurationMs / 1000} 秒；
                  单条回复累计最长 ${LIMITS.maxTotalDurationMs / 1000} 秒；强度硬上限 ${Math.round(LIMITS.maxIntensity * 100)}%。
                  多个 &lt;toy&gt; 标签按出现顺序执行一次，不循环。
                </div>
              </div>
              <div class="if-section">
                <div class="if-section-title">手动低强度测试</div>
                <div class="if-btn-group">
                  <button class="if-btn if-btn-secondary" id="ifs-test-vibrate">震动测试 10%</button>
                  <button class="if-btn if-btn-secondary" id="ifs-test-suck">气泵测试 10%</button>
                </div>
              </div>
              <div class="if-section">
                <button class="if-btn if-btn-danger" id="ifs-stop" style="width:100%">紧急停止所有设备</button>
              </div>
              <div class="if-section">
                <div class="if-section-title">运行日志</div>
                <div id="ifs-log" style="background:rgba(0,0,0,.25);padding:8px;height:120px;overflow:auto;font:11px monospace;border-radius:5px"></div>
              </div>
            </div>
          </div>
        </div>`;

        if (!$('#intiface-safe-sequence-drawer').length) {
            $('#extensions_settings').append(html);
            $('#intiface-safe-sequence-drawer .inline-drawer-toggle').on('click', function () {
                $(this).next('.inline-drawer-content').toggle();
            });
            $('#ifs-connect').on('click', () => {
                settings.serverAddress = String($('#ifs-server-address').val() || '').trim();
                saveSettings();
                connectToServer().catch(err => log(`连接失败：${String(err)}`, 'error'));
            });
            $('#ifs-disconnect').on('click', () => disconnectFromServer());
            $('#ifs-stop').on('click', () => cancelSequence('用户紧急停止'));
            $('#ifs-enabled').on('change', function () {
                settings.enabled = $(this).prop('checked');
                saveSettings();
                if (!settings.enabled) cancelSequence('自动控制已关闭');
                log(settings.enabled ? 'AI 自动控制已启用' : 'AI 自动控制已关闭');
            });
            $('#ifs-autoconnect').on('change', function () {
                settings.autoConnect = $(this).prop('checked');
                saveSettings();
            });
            $('#ifs-test-vibrate').on('click', () => runSequence([{ vibrate: 0.10, duration: 700 }], '手动震动测试'));
            $('#ifs-test-suck').on('click', () => runSequence([{ suck: 0.10, duration: 700 }], '手动气泵测试'));
        }
        $('#ifs-server-address').val(settings.serverAddress);
        $('#ifs-enabled').prop('checked', settings.enabled);
        $('#ifs-autoconnect').prop('checked', settings.autoConnect);
        updateConnectionUI();
        updateDevicesUI();
    }

    function updateConnectionUI() {
        $('#ifs-status-dot').css({
            background: connected ? '#22c55e' : '#ef4444',
            boxShadow: connected ? '0 0 8px rgba(34,197,94,.6)' : '0 0 8px rgba(239,68,68,.5)',
        });
        $('#ifs-status-text').text(connected ? (serverReady ? '已连接 Intiface' : '已连接，正在握手') : '未连接');
        $('#ifs-connect').toggle(!connected);
        $('#ifs-disconnect').toggle(connected);
    }

    function updateDevicesUI() {
        const el = $('#ifs-devices');
        if (!el.length) return;
        if (!devices.size) {
            el.text('尚未发现设备');
            return;
        }
        const lines = [];
        for (const [index, device] of devices) {
            const caps = getCapabilities(device);
            const labels = [];
            if (caps.some(c => c.type === 'Vibrate') || device.DeviceMessages?.VibrateCmd) labels.push('震动');
            if (caps.some(c => c.type === 'Constrict' || c.type === 'Oscillate')) labels.push('气泵');
            lines.push(`${device.DeviceName || '设备'} #${index}（${labels.join('、') || '未识别控制能力'}）`);
        }
        el.text(lines.join('\n'));
    }

    function nextMessageId() { return nextId++; }

    function sendMessage(message, timeoutMs = 5000) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Intiface WebSocket 未连接'));
        const key = Object.keys(message)[0];
        const id = message[key].Id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Buttplug 请求超时：${key}`));
            }, timeoutMs);
            pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            try {
                ws.send(JSON.stringify([message]));
            } catch (error) {
                clearTimeout(timer);
                pending.delete(id);
                reject(error);
            }
        });
    }

    function handleServerInfo(info) {
        serverReady = true;
        log(`Intiface 握手成功（协议版本 ${info.MessageVersion}）`);
        updateConnectionUI();
        sendMessage({ RequestDeviceList: { Id: nextMessageId() } }).catch(err => log(err.message, 'warn'));
        sendMessage({ StartScanning: { Id: nextMessageId() } }).catch(err => log(err.message, 'warn'));
    }

    function handleServerMessage(data) {
        let messages;
        try { messages = JSON.parse(data); } catch (error) {
            log(`无法解析服务器消息：${error.message}`, 'error');
            return;
        }
        for (const message of messages) {
            const type = Object.keys(message)[0];
            const body = message[type];
            if (type === 'ServerInfo') {
                handleServerInfo(body);
            } else if (type === 'DeviceList') {
                devices.clear();
                for (const device of (body.Devices || [])) devices.set(device.DeviceIndex, device);
                updateDevicesUI();
            } else if (type === 'DeviceAdded') {
                devices.set(body.DeviceIndex, body);
                log(`发现设备：${body.DeviceName || body.DeviceIndex}`);
                updateDevicesUI();
            } else if (type === 'DeviceRemoved') {
                devices.delete(body.DeviceIndex);
                log(`设备已断开：${body.DeviceIndex}`, 'warn');
                updateDevicesUI();
                cancelSequence('设备断开');
            } else if (type === 'Ok') {
                const item = pending.get(body.Id);
                if (item) { pending.delete(body.Id); item.resolve(body); }
            } else if (type === 'Error') {
                const item = pending.get(body.Id);
                if (item) { pending.delete(body.Id); item.reject(new Error(body.ErrorMessage || 'Buttplug 错误')); }
                else log(body.ErrorMessage || '服务器返回错误', 'warn');
            }
        }
    }

    async function connectToServer() {
        if (connected) return;
        if (!settings.serverAddress.startsWith('ws://') && !settings.serverAddress.startsWith('wss://')) {
            throw new Error('地址必须以 ws:// 或 wss:// 开头');
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            try {
                ws = new WebSocket(settings.serverAddress);
                const timeout = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        try { ws.close(); } catch (_) {}
                        reject(new Error('连接超时'));
                    }
                }, 7000);
                ws.onopen = () => {
                    connected = true;
                    updateConnectionUI();
                    const handshake = {
                        RequestServerInfo: {
                            Id: nextMessageId(),
                            ClientName: PLUGIN_NAME,
                            MessageVersion: 3,
                        },
                    };
                    try {
                        ws.send(JSON.stringify([handshake]));
                        settled = true;
                        clearTimeout(timeout);
                        resolve();
                    } catch (error) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(error);
                    }
                };
                ws.onmessage = event => handleServerMessage(event.data);
                ws.onerror = () => {
                    updateConnectionUI();
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error('WebSocket 连接失败，请检查 Intiface 地址和 Windows 防火墙'));
                    }
                };
                ws.onclose = () => {
                    connected = false;
                    serverReady = false;
                    devices.clear();
                    for (const [id, item] of pending) item.reject(new Error('连接已关闭'));
                    pending.clear();
                    currentRunId++;
                    updateConnectionUI();
                    updateDevicesUI();
                    log('Intiface 连接已关闭', 'warn');
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    async function disconnectFromServer() {
        await cancelSequence('断开连接');
        if (ws) {
            try { ws.close(); } catch (_) {}
        }
    }

    function getCapabilities(device) {
        if (!device?.DeviceMessages) return [];
        const result = [];
        const scalar = device.DeviceMessages.ScalarCmd;
        if (Array.isArray(scalar)) {
            scalar.forEach((feature, index) => result.push({
                type: feature.ActuatorType,
                index,
                cmdType: 'ScalarCmd',
            }));
        }
        const vibrate = device.DeviceMessages.VibrateCmd;
        if (vibrate && !result.some(item => item.type === 'Vibrate')) {
            const count = Number(vibrate.FeatureCount || 1);
            for (let index = 0; index < count; index++) result.push({ type: 'Vibrate', index, cmdType: 'VibrateCmd' });
        }
        return result;
    }

    async function setActuators(deviceIndex, step) {
        const device = devices.get(deviceIndex);
        if (!device) return false;
        const caps = getCapabilities(device);
        const scalars = [];
        let legacyVibrate = false;

        if (step.vibrate !== undefined) {
            const vibrators = caps.filter(item => item.type === 'Vibrate' && item.cmdType === 'ScalarCmd');
            if (vibrators.length) {
                for (const item of vibrators) scalars.push({
                    Index: item.index,
                    Scalar: step.vibrate,
                    ActuatorType: 'Vibrate',
                });
            } else if (device.DeviceMessages?.VibrateCmd) {
                legacyVibrate = true;
            }
        }

        if (step.suck !== undefined) {
            const suction = caps.filter(item => item.type === 'Constrict' || item.type === 'Oscillate');
            for (const item of suction) scalars.push({
                Index: item.index,
                Scalar: step.suck,
                ActuatorType: item.type,
            });
        }

        let sent = false;
        if (scalars.length) {
            await sendMessage({
                ScalarCmd: {
                    Id: nextMessageId(),
                    DeviceIndex: deviceIndex,
                    Scalars: scalars,
                },
            });
            sent = true;
        }
        if (legacyVibrate) {
            const count = Number(device.DeviceMessages.VibrateCmd.FeatureCount || 1);
            const speeds = Array.from({ length: count }, (_, index) => ({ Index: index, Speed: step.vibrate }));
            await sendMessage({
                VibrateCmd: {
                    Id: nextMessageId(),
                    DeviceIndex: deviceIndex,
                    Speeds: speeds,
                },
            });
            sent = true;
        }
        return sent;
    }

    async function stopAllDevices() {
        if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            await sendMessage({ StopAllDevices: { Id: nextMessageId() } }, 3000);
        } catch (error) {
            log(`停止命令未获确认：${error.message}`, 'warn');
        }
    }

    async function cancelSequence(reason = '取消当前序列') {
        currentRunId++;
        log(reason, 'warn');
        await stopAllDevices();
    }

    function parseAttributes(source) {
        const attrs = {};
        const regex = /([a-zA-Z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
        let match;
        while ((match = regex.exec(source)) !== null) {
            attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? 'true';
        }
        return attrs;
    }

    function parseLevelList(raw) {
        return String(raw).split(',').map(value => Number(value.trim())).filter(value => Number.isFinite(value));
    }

    function parseToyTags(messageText) {
        let text = String(messageText || '');
        if (text.includes('&lt;') || text.includes('&gt;')) {
            const textarea = document.createElement('textarea');
            textarea.innerHTML = text;
            text = textarea.value;
        }

        const parsed = [];
        const regex = /<toy\b([^>]*)\/?>/gi;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const attrs = parseAttributes(match[1]);
            if (Object.prototype.hasOwnProperty.call(attrs, 'stop')) {
                parsed.push({ stop: true });
                break;
            }

            const vibrateValues = attrs.vibrate !== undefined ? parseLevelList(attrs.vibrate) : [];
            const suckValues = attrs.suck !== undefined ? parseLevelList(attrs.suck) : [];
            if (!vibrateValues.length && !suckValues.length) continue;

            const requestedDuration = Math.floor(finiteNumber(attrs.duration, LIMITS.defaultDurationMs));
            const sequenceLength = Math.max(vibrateValues.length, suckValues.length, 1);
            const stepDuration = Math.max(LIMITS.minDurationMs, Math.floor(requestedDuration / sequenceLength));

            for (let index = 0; index < sequenceLength; index++) {
                const step = { duration: stepDuration };
                if (vibrateValues.length) step.vibrate = vibrateValues[Math.min(index, vibrateValues.length - 1)];
                if (suckValues.length) step.suck = suckValues[Math.min(index, suckValues.length - 1)];
                parsed.push(step);
            }
        }
        return parsed;
    }

    function applyHardLimits(parsed) {
        const safe = [];
        let remainingMs = LIMITS.maxTotalDurationMs;

        for (const original of parsed) {
            if (original.stop) {
                safe.push({ stop: true });
                break;
            }
            if (safe.length >= LIMITS.maxActionsPerReply || remainingMs < LIMITS.minDurationMs) break;

            const step = {};
            const requested = Math.floor(finiteNumber(original.duration, LIMITS.defaultDurationMs));
            const duration = Math.min(
                LIMITS.maxDurationMs,
                Math.max(LIMITS.minDurationMs, requested),
                remainingMs,
            );
            if (duration < LIMITS.minDurationMs) break;

            if (original.vibrate !== undefined && Number.isFinite(Number(original.vibrate))) {
                step.vibrate = clamp(Number(original.vibrate), 0, LIMITS.maxIntensity);
            }
            if (original.suck !== undefined && Number.isFinite(Number(original.suck))) {
                step.suck = clamp(Number(original.suck), 0, LIMITS.maxIntensity);
            }
            if (step.vibrate === undefined && step.suck === undefined) continue;

            step.duration = duration;
            safe.push(step);
            remainingMs -= duration;
        }

        if (safe.length < parsed.length) {
            log(`安全限制：本条回复 ${parsed.length} 个步骤，实际执行 ${safe.length} 个`, 'warn');
        }
        return safe;
    }

    async function runSequence(steps, source = 'AI 回复') {
        if (!connected || !serverReady || devices.size === 0) {
            log('没有已连接设备，忽略控制序列', 'warn');
            return;
        }
        const safeSteps = applyHardLimits(steps);
        if (!safeSteps.length) return;

        const runId = ++currentRunId;
        log(`${source}：开始执行 ${safeSteps.length} 个有序步骤`);
        try {
            for (let index = 0; index < safeSteps.length; index++) {
                if (runId !== currentRunId || !settings.enabled && source === 'AI 回复') break;
                const step = safeSteps[index];

                if (step.stop) {
                    await stopAllDevices();
                    log('序列包含停止指令，后续步骤已取消');
                    break;
                }

                const targetIndices = [...devices.keys()];
                let sent = false;
                for (const deviceIndex of targetIndices) {
                    try {
                        const result = await setActuators(deviceIndex, step);
                        sent = sent || result;
                    } catch (error) {
                        log(`设备 ${deviceIndex} 指令失败：${error.message}`, 'error');
                    }
                }
                if (!sent) {
                    log('当前步骤没有匹配到设备支持的功能，已跳过（不会用其他动作代替）', 'warn');
                } else {
                    const labels = [];
                    if (step.vibrate !== undefined) labels.push(`震动 ${Math.round(step.vibrate * 100)}%`);
                    if (step.suck !== undefined) labels.push(`气泵 ${Math.round(step.suck * 100)}%`);
                    log(`步骤 ${index + 1}/${safeSteps.length}：${labels.join(' + ')}，${step.duration}ms`);
                    await sleep(step.duration);
                }

                if (runId !== currentRunId) break;
                await stopAllDevices();
                if (index < safeSteps.length - 1) await sleep(LIMITS.gapBetweenActionsMs);
            }
        } finally {
            if (runId === currentRunId) await stopAllDevices();
            log('本次序列结束');
        }
    }

    function getLatestAssistantMessage() {
        if (!getContextFn) return null;
        try {
            const context = getContextFn();
            const chat = context?.chat;
            if (!Array.isArray(chat)) return null;
            for (let index = chat.length - 1; index >= 0; index--) {
                const message = chat[index];
                if (message && message.is_user !== true && typeof message.mes === 'string' && message.mes.trim()) {
                    return { index, chatLength: chat.length, text: message.mes };
                }
            }
        } catch (error) {
            log(`读取聊天消息失败：${error.message}`, 'warn');
        }
        return null;
    }

    function processCompletedAIMessage() {
        if (!settings.enabled || !connected || !serverReady) return;
        const latest = getLatestAssistantMessage();
        if (!latest) return;
        const key = `${latest.index}:${latest.chatLength}:${latest.text}`;
        if (key === lastProcessedKey) return;
        lastProcessedKey = key;

        const parsed = parseToyTags(latest.text);
        if (!parsed.length) return; // 普通回复不发控制命令
        runSequence(parsed, 'AI 回复').catch(error => log(`序列执行异常：${error.message}`, 'error'));
    }

    async function resolveContext() {
        if (window.getContext) return window.getContext;
        if (window.SillyTavern?.getContext) return window.SillyTavern.getContext;
        const paths = ['../../../../extensions.js', '../../../extensions.js', '../../extensions.js'];
        for (const path of paths) {
            try {
                const module = await import(path);
                if (module.getContext) return module.getContext;
            } catch (_) {}
        }
        return null;
    }

    function attachGenerationEvents() {
        let attached = false;
        if (getContextFn) {
            try {
                const context = getContextFn();
                eventSource = context?.eventSource;
                eventTypes = context?.event_types;
                if (eventSource?.on && eventTypes) {
                    if (eventTypes.GENERATION_STARTED) {
                        eventSource.on(eventTypes.GENERATION_STARTED, () => {
                            skipNextGenerationEnd = false;
                            cancelSequence('新一轮生成开始，停止上一轮设备动作');
                        });
                    }
                    if (eventTypes.GENERATION_STOPPED) {
                        eventSource.on(eventTypes.GENERATION_STOPPED, () => {
                            skipNextGenerationEnd = true;
                            cancelSequence('生成被用户停止，设备已停止');
                        });
                    }
                    if (eventTypes.GENERATION_ENDED) {
                        eventSource.on(eventTypes.GENERATION_ENDED, () => {
                            if (skipNextGenerationEnd) {
                                skipNextGenerationEnd = false;
                                return;
                            }
                            processCompletedAIMessage();
                        });
                        attached = true;
                    }
                    if (eventTypes.CHAT_CHANGED) {
                        eventSource.on(eventTypes.CHAT_CHANGED, () => {
                            lastProcessedKey = '';
                            cancelSequence('切换聊天，设备已停止');
                        });
                    }
                }
            } catch (error) {
                log(`事件监听初始化失败：${error.message}`, 'warn');
            }
        }

        if (!attached) {
            log('未找到 GENERATION_ENDED 事件，启用稳定文本轮询备用模式', 'warn');
            fallbackTimer = setInterval(() => {
                if (!settings.enabled || !connected || !serverReady) return;
                const latest = getLatestAssistantMessage();
                if (!latest) return;
                const key = `${latest.index}:${latest.chatLength}:${latest.text}`;
                if (latest.text !== fallbackLastText) {
                    fallbackLastText = latest.text;
                    fallbackStableSince = Date.now();
                    return;
                }
                if (Date.now() - fallbackStableSince >= 1500 && key !== lastProcessedKey) {
                    processCompletedAIMessage();
                }
            }, 500);
        } else {
            log('已监听 SillyTavern GENERATION_ENDED：仅在回复完成后解析');
        }
    }

    async function initialize() {
        loadSettings();
        initUI();
        log(`安全序列控制器 ${PLUGIN_VERSION} 已加载`);
        log(`硬限制：强度≤${Math.round(LIMITS.maxIntensity * 100)}%，单步≤${LIMITS.maxDurationMs}ms，单回复≤${LIMITS.maxActionsPerReply}步 / ${LIMITS.maxTotalDurationMs}ms`);

        getContextFn = await resolveContext();
        if (!getContextFn) {
            log('无法取得 SillyTavern getContext，AI 自动解析暂不可用', 'error');
        } else {
            attachGenerationEvents();
        }

        if (settings.autoConnect) {
            setTimeout(() => connectToServer().catch(error => log(error.message, 'error')), 1200);
        }
    }

    jQuery(initialize);
})();
