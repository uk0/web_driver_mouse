/**
 * i18n — Minimal internationalization.
 * Auto-detects browser language; toggle between zh / en.
 */

const T = {
  zh: {
    connection:     '设备连接',
    notConnected:   '未连接',
    connected:      '已连接',
    disconnect:     '断开',
    name:           '名称',
    profiles:       '配置方案',
    saveQuick:      '保存',
    newProfile:     '新建',
    configRestored: '已自动应用配置方案',
    battery:        '电池',
    refresh:        '刷新',
    unknown:        '未知',
    dpi:            'DPI',
    custom:         '自定义',
    apply:          '应用',
    xySplit:        'X / Y 分离',
    pollingRate:    '回报率',
    rotation:       '旋转角度',
    mouseTest:      '鼠标测试',
    log:            '日志',
    clear:          '清除',
    qrTitle:        '你的鼠标不在支持列表？',
    qrDesc:         '扫码关注公众号，提交你的鼠标型号和 VID/PID，我们会逐步适配更多设备。',
    qrHint:         '长按识别 · 关注「你起来我讲两句」',
    // log messages
    logReady:       'WebHID API 可用，准备就绪',
    logNoWebHID:    '当前浏览器不支持 WebHID API，请使用 Chrome 89+ 或 Edge 89+',
    logConnecting:  '正在连接 {brand} 鼠标...',
    logConnected:   '已连接: {name} ({vid}:{pid})',
    logSerial:      '序列号: {sn}',
    logNoSerial:    '序列号: 未获取到',
    logAutoConnect: '检测到已授权的 {brand} 设备，自动连接...',
    logAutoOk:      '自动连接成功: {name} ({vid}:{pid})',
    logAutoFail:    '自动连接未成功 ({err})，请手动连接',
    logDisconnected:'已断开连接',
    logSetDpi:      '设置 DPI: {v}',
    logDpiOk:       'DPI 已设置为 {v}',
    logSetRate:     '设置回报率: {v} Hz',
    logRateOk:      '回报率已设置为 {v} Hz',
    logBatQuery:    '查询电池状态...',
    logBatOk:       '电池: {pct}% | {status}',
    logBatRetry:    '电池查询重试 ({i}/{max})...',
    logBatPoll:     '电量自动刷新已启动 ({s}s)',
    logSetRot:      '设置旋转角度: {v}°',
    logRotOk:       '旋转角度已设置为 {v}°',
    logConfigFound: '检测到配置方案 "{name}"，正在自动应用...',
    logConfigDone:  '保存的配置已全部应用',
    logApplyDpi:    '自动应用 DPI: {v}',
    logApplyRate:   '自动应用回报率: {v} Hz',
    logApplyRot:    '自动应用旋转角度: {v}°',
    logProfileNew:  '已创建方案 "{name}"',
    logProfileDel:  '已删除方案 "{name}"',
    logProfileSave: '已保存到方案 "{name}"',
    logProfileRen:  '方案已重命名: "{old}" -> "{new}"',
    logApplying:    '正在应用方案 "{name}"...',
    charging:       '充电中',
    notCharging:    '未充电',
    batDischarging: '放电中',
    batCharging:    '充电中',
    batNearlyFull:  '即将充满',
    batFull:        '已充满',
    batSlowDrain:   '缓慢放电',
    profilePrompt:  '输入配置方案名称:',
    noProfiles:     '无配置方案 — 点击 + 创建',
    dblClickRename: '双击重命名',
    delete:         '删除',
    today:          'Today',
  },

  en: {
    connection:     'Connection',
    notConnected:   'Disconnected',
    connected:      'Connected',
    disconnect:     'Disconnect',
    name:           'Name',
    profiles:       'Profiles',
    saveQuick:      'Save',
    newProfile:     'New',
    configRestored: 'Saved profile auto-applied',
    battery:        'Battery',
    refresh:        'Refresh',
    unknown:        'Unknown',
    dpi:            'DPI',
    custom:         'Custom',
    apply:          'Apply',
    xySplit:        'X / Y Split',
    pollingRate:    'Polling Rate',
    rotation:       'Rotation',
    mouseTest:      'Mouse Test',
    log:            'Log',
    clear:          'Clear',
    qrTitle:        'Mouse not supported?',
    qrDesc:         'Scan the QR code, submit your mouse model and VID/PID. We\'ll add support gradually.',
    qrHint:         'Follow us on WeChat',
    logReady:       'WebHID API available, ready',
    logNoWebHID:    'WebHID not supported. Use Chrome 89+ or Edge 89+.',
    logConnecting:  'Connecting {brand} mouse...',
    logConnected:   'Connected: {name} ({vid}:{pid})',
    logSerial:      'Serial: {sn}',
    logNoSerial:    'Serial: not available',
    logAutoConnect: 'Found authorized {brand} device, auto-connecting...',
    logAutoOk:      'Auto-connected: {name} ({vid}:{pid})',
    logAutoFail:    'Auto-connect failed ({err}), connect manually',
    logDisconnected:'Disconnected',
    logSetDpi:      'Setting DPI: {v}',
    logDpiOk:       'DPI set to {v}',
    logSetRate:     'Setting polling rate: {v} Hz',
    logRateOk:      'Polling rate set to {v} Hz',
    logBatQuery:    'Querying battery...',
    logBatOk:       'Battery: {pct}% | {status}',
    logBatRetry:    'Battery retry ({i}/{max})...',
    logBatPoll:     'Battery polling started ({s}s)',
    logSetRot:      'Setting rotation: {v}°',
    logRotOk:       'Rotation set to {v}°',
    logConfigFound: 'Found profile "{name}", auto-applying...',
    logConfigDone:  'All saved settings applied',
    logApplyDpi:    'Auto-apply DPI: {v}',
    logApplyRate:   'Auto-apply polling rate: {v} Hz',
    logApplyRot:    'Auto-apply rotation: {v}°',
    logProfileNew:  'Created profile "{name}"',
    logProfileDel:  'Deleted profile "{name}"',
    logProfileSave: 'Saved to profile "{name}"',
    logProfileRen:  'Renamed: "{old}" -> "{new}"',
    logApplying:    'Applying profile "{name}"...',
    charging:       'Charging',
    notCharging:    'Not charging',
    batDischarging: 'Discharging',
    batCharging:    'Charging',
    batNearlyFull:  'Nearly Full',
    batFull:        'Full',
    batSlowDrain:   'Slow Discharge',
    profilePrompt:  'Enter profile name:',
    noProfiles:     'No profiles — click + to create',
    dblClickRename: 'Double-click to rename',
    delete:         'Delete',
    today:          'Today',
  },
};

let _lang = 'zh';

export function detectLang() {
  const saved = localStorage.getItem('_mouse_lang');
  if (saved && T[saved]) { _lang = saved; return _lang; }
  const nav = (navigator.language || '').toLowerCase();
  _lang = nav.startsWith('zh') ? 'zh' : 'en';
  return _lang;
}

export function getLang() { return _lang; }

export function setLang(lang) {
  _lang = T[lang] ? lang : 'en';
  localStorage.setItem('_mouse_lang', _lang);
  applyDOM();
  return _lang;
}

export function t(key, vars) {
  let s = (T[_lang] && T[_lang][key]) || (T.en && T.en[key]) || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(`{${k}}`, v);
    }
  }
  return s;
}

/** Apply translations to all elements with data-i18n attribute. */
export function applyDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    if (attr) {
      el.setAttribute(attr, t(key));
    } else {
      el.textContent = t(key);
    }
  });
  document.documentElement.lang = _lang === 'zh' ? 'zh-CN' : 'en';
}
