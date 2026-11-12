// ==UserScript==
// @name         雨课堂 · 自动连播（完成度驱动）
// @namespace    local.yuketang.autoplay
// @version      1.0
// @description  任意雨课堂课程通用：自动进入视频，按左侧目录跳到最近的未完成视频
// @author       local
// @match        https://*.yuketang.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 判定逻辑（不依赖读取 <video>，播放器在 iframe 里也同样有效）：
 *   1. 页面出现「去学习」            → 点进去，开始播视频
 *   2. 节点级「完成度：100%」        → 这一节学完了 → 见第 3 条
 *   3. 学完之后不去盲点「下一个知识点」，而是先读左侧知识点目录：
 *      行首的「视频 / 作业 / 讨论」是节点类型，行尾的绿色对勾是已完成。
 *      据此算出「还没看完的视频」有哪些，直接点最近的那一行跳过去。
 *      作业、章节首页、认不出的页面根本不经过，也就不会再有几十秒的空等。
 *      读不到目录（面板收起 / 改版）才退回点「下一个知识点」。
 *   4. 播放被暂停                    → 播放器所在的 iframe 每 2 秒自动拉起
 *                                      （被自动播放策略拦截就静音再试）
 *   5. 卡住（找不到按钮 / 点不动）    → 45 秒后自动重试，间隔逐步拉长，永不放弃
 *
 * 两个坑（都踩过）：
 *   · 视频节点卡片上也印着「考核截止时间」，别拿它当作业页特征，否则视频页会被
 *     当成作业 4 秒跳过。
 *   · 目录是可折叠的三层树（第N节 → 10.4.1 知识点 → 视频 10.4）。折叠起来的知识点
 *     在目录里根本看不到视频行，所以要按“带编号的行”“没展开的章节”做兜底候选。
 *
 * 区分两个完成度：节点级带冒号「完成度：15%」，课程级不带冒号「完成度 13.21%」。
 *
 * 适用范围：
 *   · 认的是课程页路径 /ai-workspace/lms-graph/{课程号}/...，不认具体某门课。
 *     同一套界面下的任何课程（含换班、换学期）都能直接用，无需改代码。
 *   · 老版课程页（/v2/web/... 那套）界面结构完全不同，本脚本不接管点击，
 *     只在播放器 iframe 里保留“别被暂停”这一项。
 *   · 代码里不含账号、姓名、学号、Cookie、课程号等个人信息。
 *
 * 免责：仅供个人学习辅助，按「现状」提供。使用前请阅读仓库 README 的免责声明，
 *      并自行确认所在院校与平台的相关规定；相关后果由使用者自行承担。
 */

(function () {
  'use strict';

  const IS_TOP = window.top === window.self;
  // 课程页路径特征：/ai-workspace/lms-graph/{课程号}/...
  // 以前这里写死过某一门课的号，导致换课程就不起作用；现在按路径认，
  // 任何一门用了这套「新版课程页」的课都能跑。
  const COURSE_RE = /\/ai-workspace\/lms-graph\/(\d+)/;
  const VER = 'v1.0';

  // ============================================================
  // 范围约束
  //   播放器其实跑在 iframe 里（顶层 DOM 里根本没有 <video>），所以脚本
  //   必须也注入子框架，否则屏蔽不到播放器的暂停检测——这也是 matches
  //   放宽到 *.yuketang.cn 的原因。
  //   但“自动换节”这套逻辑只在【顶层 + 新版课程页】执行：老版课程页、其他
  //   雨课堂页面只保留子框架里的“别被暂停”，不做任何点击。
  // ============================================================
  const courseIdOf = (u) => {
    const m = String(u || location.href).match(COURSE_RE);
    return m ? m[1] : '';
  };
  // 只认路径，不看查询串：点目录时地址里会带一堆参数，不能因此认不出来
  const inCourse = () => !!courseIdOf(location.href);
  const ACTIVE = !IS_TOP || inCourse();

  if (ACTIVE) { spoofVisibility(); pinPlayback(); }

  // ============================================================
  // 把 <video>.pause() 钉住
  // 平台的播放器是“我不看你 → 调 pause()”这种实现。我们这边一直 play()，
  // 它一直 pause()，来回抢的结果就是画面在播放/暂停之间不停闪。
  // 这里直接把平台那一侧的 pause() 变成空操作，只放行两种：
  //   1. 视频已经播完（ended），自然停
  //   2. 你按了 Alt+P 主动停手（S.userPaused = true）
  //
  // 注意这里判的是 userPaused，不是 enabled。
  // enabled=false 只表示“脚本动作暂停一会儿（重试退避）”，不是“允许平台把视频停下”。
  // 之前判 enabled 就出过这个毛病：脚本一进退避窗口，平台的 pause() 就不再被拦，
  // 你点继续，它立刻又给你按停。
  // ============================================================
  function pinPlayback() {
    try {
      const proto = HTMLMediaElement.prototype;
      if (proto.__apPinned) { S.pinned = true; return; }
      const orig = proto.pause;
      proto.pause = function () {
        try {
          if (this.ended) return orig.apply(this, arguments);
        } catch (e) {}
        let off = false;
        try { off = (typeof S !== 'undefined') && S.userPaused; } catch (e) {}
        if (off) return orig.apply(this, arguments);
        try { S.pauseBlocked++; } catch (e) {}
        return undefined;
      };
      proto.__apPinned = true;
      S.pinned = true;
    } catch (e) {}
  }

  // ============================================================
  // 屏蔽“切走页面/最小化就暂停”的检测
  // 播放器靠 document.hidden / visibilityState / blur 事件判断你是否在看，
  // 在页面脚本执行前把这些信号锁成“一直可见、一直有焦点”。
  // 注意：这是绕过平台的反挂机检测，脚本其他部分不依赖它。
  // ============================================================
  function spoofVisibility() {
    try {
      const dp = Document.prototype;
      Object.defineProperty(dp, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(dp, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(dp, 'webkitHidden', { get: () => false, configurable: true });
      Object.defineProperty(dp, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    } catch (e) {}

    try { document.hasFocus = () => true; } catch (e) {}

    // 在捕获阶段拦掉这些事件，播放器根本收不到
    const EVENTS = ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze'];
    const kill = (e) => { e.stopImmediatePropagation(); };
    EVENTS.forEach(t => {
      try { window.addEventListener(t, kill, true); } catch (e) {}
      try { document.addEventListener(t, kill, true); } catch (e) {}
    });
  }

  // ============================================================
  // 可调参数
  //   pollMs 是“定时检查”的间隔，默认 3 秒。改这里即可，也可以在
  //   页面里按 Alt+[ 变快、Alt+] 变慢（500ms ~ 120s），会存到
  //   localStorage，刷新后沿用。
  //   注意：它和浏览器对后台标签页的“节流”是两回事，见下方 note。
  // ============================================================
  const CFG = {
    pollMs: 3000,           // 定时检查间隔（毫秒）
    speed: 1,               // 倍速，1 = 原速。只在能拿到 <video> 时生效
    finishPct: 99,          // 节点完成度达到该值即认为本节学完（平台显示整数）
    finishConfirmMs: 6000,  // 看到完成标记后先确认这么久再切节（防一节多视频被跳过）
    nextCooldownMs: 12000,  // 两次点击「下一个知识点」的最小间隔
    goLearnCooldownMs: 15000, // 两次点击「去学习」的最小间隔
    noNodeToleranceMs: 20000, // 兼容字段：读不到完成度时的兜底等待
    hwSkipMs: 12000,           // 作业节点：确认是作业页之后等这么久再跳过
    homeSkipMs: 25000,         // 知识点首页但找不到「去学习」：等这么久再跳过
    unknownSkipMs: 30000,      // 认不出的页面（渲染中 / 改版）
    videoNodeGraceMs: 90000,   // 明知是视频节点却读不到完成度：最多等这么久
    videoReenterMax: 2,        // 等超时后“重新进入本节”几次，之后才认栽换下一节
    softRetryMs: 900000,       // 软的“试过”标记多久失效（失效后回头补看）
    endRescanMs: 60000,        // 目录里已无未完成视频时，多久重扫一次（只看不动手）
    backfillMs: 600000,        // 多久做一次真正的“回补”（清掉软标记、把漏下的再过一遍）
    stallWarnMs: 120000,       // 完成度多久没变化就认为被暂停了
    maxRepeatClicks: 8,     // 同一页面重复点击上限
    maxRetries: 30,         // 卡住后自动重试的次数（挂机场景别轻易彻底放弃）
    retryWaitMs: 45000,     // 每次重试前等多久
    resumeDelayMs: 4000,    // 连续暂停超过这个时长才去拉，太急会和播放器打架
    resumeBudget: 8,        // 每分钟最多拉几次，超过就退避 60 秒
    tocEnabled: true,       // 是否用左侧目录「直接跳到最近的未完成视频」
    tocScanTtlMs: 20000,    // 目录扫描结果缓存多久（读一次目录要遍历几千个节点）
    tocJumpCooldownMs: 8000,// 两次目录跳转的最小间隔
    tocMaxFail: 4,          // 连续几次点了目录没反应就暂时停用目录跳转
    segGraceMs: 40000,      // 同一节里换了片源后，多久之内绝不切节（等新视频起来）
    pollMinMs: 500,
    pollMaxMs: 120000,
  };

  // 外部覆盖：?ap_poll=1000 或 localStorage，优先级 参数 > 存储 > 默认
  (function loadPollOverride() {
    const clamp = (n) => (n >= CFG.pollMinMs && n <= CFG.pollMaxMs ? n : null);
    let v = null;
    try {
      const q = clamp(parseInt(new URLSearchParams(location.search).get('ap_poll') || '', 10));
      if (q) v = q;
    } catch (e) {}
    if (v === null) {
      try { v = clamp(parseInt(localStorage.getItem('yt_autoplay_poll') || '', 10)); } catch (e) {}
    }
    if (v) CFG.pollMs = v;
  })();

  const S = {
    enabled: true,
    userPaused: false,   // 只有 Alt+P 才会置 true：表示“人要求停下”
    pauseBlocked: 0,     // 拦住了多少次平台发起的 pause()，状态条上能看见
    pinned: false,       // pause() 是否已被钉住
    lastHref: location.href,
    lastClickAt: 0,
    lastLearnAt: 0,
    learnClicks: 0,
    repeatClicks: 0,
    retryCount: 0,
    stallNudges: 0,
    noNodeSince: 0,
    stopReason: '',
    lastPct: -1,
    pctSeenAt: 0,
    lastMsg: '',
    pinWarned: false,
    nearEnd: false,        // 本页是否曾经播到接近完成（用于区分“刚播完”和“一进来就已完成”）
    finishSeenAt: 0,       // 首次看到完成标记的时间
    finishFirstAt: 0,      // 完成标记第一次出现的时间（用于兜底上限）
    finishSig: '',         // 首次看到完成标记时的播放器指纹
    backoffUntil: 0,
    resumeLog: [],
    skipped: [],      // 被跳过的非视频节点清单，控制台可查
    // --- 目录跳转 ---
    tried: new Set(),   // 硬标记：平台确认已完成 / 折叠节点已进去看过，本轮不再回头
    triedAt: new Map(), // 软标记：试过但没确认完成，过了 softRetryMs 要回头补
    lastTocJumpAt: 0,
    tocFail: 0,         // 点了目录没反应的次数
    tocWrong: 0,        // 目录把“已完成”的节点当成未完成、跳过去扑空的次数
    tocOffUntil: 0,     // 连续失败后的冷却截止时间
    tocCache: null,
    tocCacheAt: 0,
    // --- 节点 / 片源身份 ---
    nodeId: '',         // URL 里的 node_id：一节的身份
    videoId: '',        // URL 里的 video/{id}：一节里某一段视频的身份
    segChangedAt: 0,    // 同一节里换片的时刻
    segGraceLogged: false,
    leftCount: null,    // 目录里还剩几节视频没看完（显示在状态条第二行）
    pendingSince: 0,    // 播放器里还有片子没起来，从什么时候开始等
    currentHow: '',     // “当前行”是怎么认出来的：node / active / hover / title
    learnHref: '',      // 已经点过「去学习」的地址，避免同一页反复点
    endScanAt: 0,       // 上次确认“目录里没有未完成视频”的时刻
    backfillAt: 0,      // 上次做“回补”的时刻
    probeAt: 0,         // 上次让平台按钮探路的时刻
    lastJumpHref: '',   // 上一次目录跳转前的地址（用来判断到底有没有真的跳走）
  };

  // ---------- DOM 小工具 ----------
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  // 文本完全相等的最内层可见元素。requireMain=true 时排除侧栏/目录树，
  // 避免把左侧知识点列表里同名按钮当成本页的操作入口（例如目录里每一行
  // 都有「去学习」，误点会直接跳到别的节点）。
  function findText(text, requireMain) {
    const all = document.querySelectorAll('button,a,div,span,li,p,i,em,strong');
    for (const n of all) {
      if ((n.textContent || '').trim() !== text) continue;
      if (!visible(n)) continue;
      if (requireMain && inSidebar(n)) continue;
      let cur = n;
      for (;;) {
        const child = Array.from(cur.children).find(c => (c.textContent || '').trim() === text);
        if (!child) break;
        cur = child;
      }
      if (requireMain && inSidebar(cur)) continue;
      return cur;
    }
    return null;
  }

  function clickableOf(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const tag = cur.tagName;
      const cls = (cur.className || '').toString();
      if (tag === 'BUTTON' || tag === 'A' || tag === 'LI' ||
          cur.getAttribute('role') === 'button' ||
          /btn|button|next|prev|link/i.test(cls)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  // 只触发一次点击。之前是先派发 mousedown/mouseup/click 再调 el.click()，
  // 等于点了两下——「下一个知识点」有可能因此跳两节。改成只走一条路。
  function click(el) {
    if (!el) return false;
    try {
      if (typeof el.click === 'function') { el.click(); return true; }
    } catch (e) {}
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return true;
  }

  // ---------- 读取节点级完成度 ----------
  // 只认带冒号的「完成度：15%」，避免误读左侧栏的课程总完成度（不带冒号）。
  // 左侧目录树里某些节点也可能带冒号，所以排除 aside/nav/树/目录/侧栏容器，
  // 并在多个候选里取文本最短的那个（最贴近数值本身）。
  const PCT_RE = /完成度\s*[:：]\s*(\d+(?:\.\d+)?)\s*%/;

  function inSidebar(el) {
    return !!el.closest(
      'aside,nav,[role="tree"],[role="navigation"],' +
      '[class*="tree"],[class*="Tree"],[class*="catalog"],[class*="Catalog"],' +
      '[class*="sidebar"],[class*="sider"],[class*="menu"],[class*="Menu"]'
    );
  }

  function readNodePct() {
    const els = document.querySelectorAll('div,span,p,em,i,strong');
    let best = null, bestLen = 1e9;      // 主区域里的候选
    let side = null, sideLen = 1e9;      // 侧栏里的候选（兜底）
    for (const el of els) {
      const t = el.textContent || '';
      if (t.length > 80) continue;               // 跳过包裹整块的大容器
      if (!PCT_RE.test(t)) continue;
      if (!visible(el)) continue;
      if (inSidebar(el)) {
        if (t.length < sideLen) { sideLen = t.length; side = el; }
      } else if (t.length < bestLen) {
        bestLen = t.length; best = el;
      }
    }
    const pick = best || side;
    if (!pick) return null;
    const m = (pick.textContent || '').match(PCT_RE);
    return m ? parseFloat(m[1]) : null;
  }

  const KIND_LABEL = { hw: '作业节点', home: '知识点首页', unknown: '未知页面' };

  // 读不到「完成度」时，先判断这是什么页面，再决定等多久、怎么走。
  // 旧版一律空等 120 秒，作业页和章节首页加起来能把整晚耗光，看着就像卡死。
  function classifyNoContent() {
    const body = (document.body && document.body.innerText) || '';
    // 注意：绝对不能拿「考核截止时间」当作业页特征——视频节点卡片上也印着这一行。
    // v3.3 及以前就是这么写的，于是视频页一旦暂时读不到「完成度」，4 秒就被判成
    // 作业跳过，整段视频白扔。这是“漏视频”最主要的一条。
    if (/提交答案|答题卡|本次测验|我的作答|剩余\s*\d+\s*次|已提交|开始答题/.test(body)) return 'hw';
    if (/学习单元完成情况|知识点简介|学习成果检测|相关知识点|拓展资源|知识点完成情况/.test(body)) return 'home';
    return 'unknown';
  }

  // 「学习单元完成情况 1/1」= 这个知识点下面的单元都看完了，不用再等超时
  function unitsAllDone() {
    const m = ((document.body && document.body.innerText) || '')
      .match(/学习单元完成情况\s*(\d+)\s*\/\s*(\d+)/);
    if (!m) return false;
    const a = +m[1], b = +m[2];
    return b > 0 && a >= b;
  }

  // 这一页到底是不是视频节点。完成度还没渲染出来时，靠这个避免把视频页
  // 当成“没有可看内容”跳过：播放器在跨域 iframe 里，顶层查不到 <video>，
  // 所以只能看卡片上的类型标签和 iframe 地址。
  function looksLikeVideoNode(st) {
    if (st && st.current && st.current.playable) return true;
    if (findText('视频', true) || findText('直播', true)) return true;
    for (const f of document.querySelectorAll('iframe')) {
      const src = (f.getAttribute('src') || '') + ' ' + (f.getAttribute('data-src') || '');
      if (/video|player|media|live|vcloud/i.test(src)) return true;
    }
    return false;
  }

  // 跳过记录：挂机跑完后能核对有没有把该看的节点漏掉
  function rememberSkip(kind) {
    const href = location.href;
    if (S.skipped.some(x => x.href === href)) return;
    S.skipped.push({ kind: KIND_LABEL[kind] || kind, title: (document.title || '').slice(0, 50), href });
    console.log('%c[雨课堂自动连播] 跳过 ' + (KIND_LABEL[kind] || kind) + '：' + href,
                'color:#9a6700');
    if (S.skipped.length === 1) {
      console.log('%c[雨课堂自动连播] 已开始记录被跳过的节点，按 Alt+S 可打印完整清单',
                  'color:#0969da');
    }
  }

  function dumpSkipped() {
    if (!S.skipped.length) { console.log('%c[雨课堂自动连播] 没有跳过任何节点', 'color:#0969da'); return; }
    console.table(S.skipped);
    console.log('%c[雨课堂自动连播] 共跳过 ' + S.skipped.length + ' 个非视频节点', 'color:#0969da');
  }

  // ---------- 动作 ----------
  function goLearn() {
    if (Date.now() - S.lastLearnAt < CFG.goLearnCooldownMs) return false;
    // 同一个地址已经点过「去学习」了：再点还是同一下，等页面自己变。
    // 否则会每 15 秒点一次，8 次之后把自己停掉（旧版就是这么自己把路堵死的）。
    if (S.learnHref === location.href) return false;
    if (S.learnClicks >= 8) {
      stop('点了 8 次「去学习」都没进入视频');
      return false;
    }
    // 只在主区域找，避免点到左侧目录里别的节点
    const el = findText('去学习', true) || findText('继续学习', true) ||
               findText('开始学习', true) || findText('立即学习', true);
    if (!el) return false;
    click(clickableOf(el));
    S.lastLearnAt = Date.now();
    S.lastClickAt = Date.now();
    S.learnHref = location.href;
    S.learnClicks++;
    console.log('%c[雨课堂自动连播] 已点「去学习」', 'color:#0969da');
    return true;
  }

  // 完整的指针事件序列。SPA 里有些按钮只认 pointerdown/mousedown，
  // 单纯 el.click() 会静默失败——作业页的「下一个知识点」就是这样。
  function fireClick(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1,
                  clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mousedown', o));
      try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
      return true;
    } catch (e) { return false; }
  }

  // 「下一个知识点」能生效的落点不止一个：文字本身、它外面那层按钮、
  // 再外面那层容器。实测不同页面上生效的落点不一样，所以排成候选依次试。
  function nextTargets() {
    const out = [];
    for (const lb of ['下一个知识点', '下一节', '下一讲']) {
      const el = findText(lb, true) || findText(lb);
      if (!el) continue;
      const c = clickableOf(el);
      [c, c && c.parentElement, el, el.parentElement].forEach(x => {
        if (x && x.nodeType === 1 && out.indexOf(x) === -1) out.push(x);
      });
    }
    return out;
  }

  function clickNext(reason) {
    const now = Date.now();
    if (now - S.lastClickAt < CFG.nextCooldownMs) return false;
    if (S.repeatClicks >= CFG.maxRepeatClicks) {
      stop('连续点击 ' + S.repeatClicks + ' 次页面都没跳转');
      return false;
    }

    const targets = nextTargets();
    if (!targets.length) {
      // 目录里确实没东西了就别再反复戳按钮（那是干耗）；否则可能只是还没渲染完
      if (tocSaysDone()) { endQuiet('目录里已经没有未完成的视频了'); return false; }
      stop('找不到「下一个知识点」按钮');
      return false;
    }

    const before = location.href;
    S.lastClickAt = now;
    S.repeatClicks++;
    console.log('%c[雨课堂自动连播] 切换下一节，原因：' + reason, 'color:#0969da');
    badge('正在切换下一节…', 'ok');

    // 逐级加重：先模拟真实点击，1.2 秒内没跳就换下一个落点。
    // 每次动手前都重新确认 URL 没变，避免已经跳走了还多点一次、一下跳两节。
    let i = 0;
    const attempt = () => {
      if (location.href !== before) return;          // 已经跳了，收工
      if (i >= targets.length) {
        if (tocSaysDone()) { endQuiet('目录里已经没有未完成的视频了'); return; }
        stop('「下一个知识点」点了没反应');
        return;
      }
      const t = targets[i++];
      fireClick(t);
      setTimeout(() => {
        if (location.href !== before) return;
        try { t.click(); } catch (e) {}              // 兜底：直接 click()
        setTimeout(() => { if (location.href === before) attempt(); }, 900);
      }, 1200);
    };
    attempt();
    return true;
  }

  // 停止不是终点：过一会儿自动再试。
  // 旧版重试 4 次就永久停下——挂机一整晚，只要中间遇到一次点不动，
  // 后面全部白等。现在改成永不放弃，只是把间隔逐步拉长（45s → 90s → 180s 封顶）。
  function stop(reason) {
    S.stopReason = reason;
    S.enabled = false;
    S.retryCount++;
    const wait = Math.min(CFG.retryWaitMs * Math.min(S.retryCount, 4), 180000);
    console.log('%c[雨课堂自动连播] 暂停中：' + reason + '，' +
                Math.round(wait / 1000) + ' 秒后重试（第 ' + S.retryCount + ' 次）', 'color:#9a6700');
    badge('稍等，正在重试…', 'warn');
    if (S.retryCount === CFG.maxRetries) {
      console.log('%c[雨课堂自动连播] 已经连续失败 ' + S.retryCount +
                  ' 次，仍在重试。检查一下页面是不是停在需要人工处理的节点（验证码/弹题/登录失效）',
                  'color:#b42318');
    }
    setTimeout(() => {
      S.enabled = true;
      S.repeatClicks = 0;
      S.noNodeSince = 0;
      tick();
    }, wait);
  }

  // 播放被暂停时尝试拉回来。
  // 关键约束：只在“连续暂停超过 resumeDelayMs”时才动手，并且有每分钟的次数上限。
  // 否则遇到播放器主动暂停（防挂机检测）就会变成 play/pause 反复闪，
  // 反而比停着更糟——之前那版就是这样。
  function tryResume() {
    const now = Date.now();
    if (S.backoffUntil && now < S.backoffUntil) return false;

    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return false;

    let acted = false;
    for (const v of vids) {
      if (!v.paused || v.ended) { v.__apPausedAt = 0; continue; }
      if (!v.__apPausedAt) { v.__apPausedAt = now; continue; }        // 刚开始暂停，再等等
      if (now - v.__apPausedAt < CFG.resumeDelayMs) continue;         // 还没到动手的时候

      // 每分钟最多拉 resumeBudget 次，超了就说明对方在反复暂停，先退避
      S.resumeLog = S.resumeLog.filter(t => now - t < 60000);
      if (S.resumeLog.length >= CFG.resumeBudget) {
        S.backoffUntil = now + 60000;
        console.log('%c[雨课堂自动连播] 播放被反复暂停（1 分钟内 ' +
                    S.resumeLog.length + ' 次），先观察 60 秒不再抢', 'color:#9a6700');
        return false;
      }
      S.resumeLog.push(now);
      acted = true;

      try {
        const p = v.play();
        if (p && p.catch) p.catch(() => {
          // 自动播放被拦截：静音后重试，静音播放一律放行
          try { v.muted = true; v.play().catch(() => {}); } catch (e) {}
        });
      } catch (e) {}
      v.__apPausedAt = 0;
    }
    return acted;
  }

  // 可选倍速：只对同文档的 <video> 生效
  function applySpeed() {
    if (!CFG.speed || CFG.speed === 1) return;
    document.querySelectorAll('video').forEach(v => {
      if (v.playbackRate !== CFG.speed) { try { v.playbackRate = CFG.speed; } catch (e) {} }
    });
  }

  // 本页面里的视频是不是处于暂停态（null = 本页没有 <video>，说明在 iframe 里）
  function localPaused() {
    const v = document.querySelector('video');
    if (!v) return null;
    return !!(v.paused && !v.ended);
  }

  // 弹题/弹窗识别：只提示，不代答
  function quizBlocker() {
    const t = (document.body && document.body.innerText) || '';
    return /请作答|开始答题|本次测验|题目\s*\d|答题卡|提交答案/.test(t);
  }

  // ============================================================
  // 目录扫描：直接跳到「最近的未完成视频」
  //
  // 「下一个知识点」是平台自己挑目标，只认它认为的下一个：中间夹着作业、
  // 章节首页就只能干等几秒再跳，而且它跟你的进度没关系。这里改成自己读
  // 左侧知识点目录——
  //   行首的「视频 / 作业 / 讨论」标签 = 节点类型（决定能不能播）
  //   行尾的绿色对勾                = 已完成
  // 于是「还没看完的视频」是一份明确的清单，直接点最近的那一行跳过去，
  // 作业和章节首页一概不经过。
  //
  // 全部靠文本和颜色判断，不依赖平台的类名，改版也不会立刻失效；
  // 读不到目录（面板收起 / 结构变了）就返回 null，调用方退回「下一个知识点」。
  // ============================================================
  // 注意别在中文标签后面加 \b：JS 的 \b 只在 \w 与空格之间成立，
  // 「视频 12.2 …」这种行会因为 频/空格 都不是 \w 而匹配失败，整份目录读成空。
  const TAG_RE = /^(视频|直播|录播|回放|微课|视频课|直播回放|音频|作业|讨论|试卷|测验|考试|文档|阅读|习题|实验|实操|案例|课件|讲义|PPT|拓展|扩展|资料)/;
  const PLAY_TAGS = /^(视频|直播|录播|回放|微课|视频课|直播回放|音频)$/;
  const CHAP_RE = /^第\s*[\d一二三四五六七八九十百]+\s*[章节讲单元课]/;
  // 「10.4.1 案例分析」这种带编号的知识点行：下面可能挂着视频，折叠起来就看不见
  const NUMROW_RE = /^\d+(?:\.\d+){1,3}\s*\S/;
  const DONE_WORD_RE = /已完成|已学完|已通过|完成度\s*[:：]\s*100\s*%|^100\s*%/;
  const DONE_CLASS_RE = /(^|[\s_-])(success|succeed|check(ed)?|done|finish(ed)?|complete(d)?|passed|tick)([\s_-]|$)/i;
  const ICON_DONE_RE = /(check|done|success|tick)/i;

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function rgbOf(color) {
    const m = String(color || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    if (p.length < 3 || p.some(n => !isFinite(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  // 只认“完成对勾那种绿”：中等饱和 + 中等亮度。
  // 选中行的浅绿底色（#d9f7be 一类，亮度 0.85 以上）落不进这个区间。
  function greenish(color) {
    const c = rgbOf(color);
    if (!c || c.a < 0.5) return false;
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return h >= 80 && h <= 175 && s >= 0.45 && l >= 0.2 && l <= 0.72;
  }

  // 目录面板：以顶部的「搜索知识点」输入框为锚点，往上找第一个
  // 够大、且不含播放器的容器。找不到再按语义树 / 常见类名兜底。
  function tocPanel() {
    const anchors = Array.from(document.querySelectorAll('input[placeholder]'))
      .filter(i => (i.getAttribute('placeholder') || '').indexOf('知识点') !== -1);
    for (const a of anchors) {
      let p = a.parentElement;
      for (let k = 0; k < 12 && p && p !== document.body; k++, p = p.parentElement) {
        if (p.querySelector('video')) continue;
        let n = 0;
        for (const el of p.querySelectorAll('div,li,a,span')) {
          const t = norm(el.textContent);
          if (t && t.length < 70 && TAG_RE.test(t) && ++n >= 3) break;
        }
        if (n >= 3) return p;
      }
    }
    const guess = document.querySelector('[role="tree"]') ||
      document.querySelector('[class*="catalog"],[class*="Catalog"],[class*="tree"],[class*="Tree"]');
    if (guess && !guess.querySelector('video')) return guess;
    return null;
  }

  // 从行内任意节点向上取整行：父节点文本和它一样就一直往上，
  // 一旦父节点多出别的文字（说明已经是外层容器）就停。
  function rowOfEl(el, panel) {
    let cur = el, p = cur.parentElement;
    while (p && p !== panel && norm(p.textContent) === norm(cur.textContent)) {
      cur = p; p = cur.parentElement;
    }
    return cur;
  }

  // 行标识：优先用平台自己的 node_id（URL 里那个），
  // 没有就退回标题文本。用来记录“试过了”，避免在两个节点之间反复跳。
  function rowKey(row) {
    for (const a of row.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(/node_id=(\d+)/);
      if (m) return 'n' + m[1];
    }
    const els = [row, ...row.querySelectorAll('*')].slice(0, 40);
    for (const el of els) {
      if (!el.getAttribute) continue;
      for (const name of ['data-node-id', 'data-nodeid', 'data-id', 'data-key', 'data-node']) {
        const v = el.getAttribute(name);
        if (v && /^\d{4,}$/.test(v)) return 'n' + v;
      }
    }
    return 't' + norm(row.textContent).slice(0, 48);
  }

  // 这一行是不是已完成：绿色对勾 / “已完成”字样 / 完成度 100%
  function rowDone(row, rowRect) {
    const t = norm(row.textContent);
    if (DONE_WORD_RE.test(t) || /[✓✔]/.test(t)) return true;
    if (/已完成|已学完/.test(row.getAttribute('aria-label') || '')) return true;
    if (row.getAttribute('aria-checked') === 'true') return true;

    const rr = rowRect || row.getBoundingClientRect();
    for (const el of row.querySelectorAll('svg,use,path,i,em,b,strong,span,div,img')) {
      // 类型胶囊（视频是紫的、作业是绿的、讨论是蓝的）自带配色，绿色不代表已完成，
      // 而且它整块都是“小元素”，早期版本会把作业行一律当成已完成。
      const et = norm(el.textContent);
      if (et && (TAG_RE.test(et) || CHAP_RE.test(et))) continue;

      const cls = String(el.getAttribute('class') || '');
      if (DONE_CLASS_RE.test(cls)) return true;
      if (el.tagName === 'use' || el.tagName === 'path') {
        const ref = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
        if (ICON_DONE_RE.test(ref)) return true;
      }
      let st;
      try { st = getComputedStyle(el); } catch (e) { continue; }
      if (!st) continue;
      const er = el.getBoundingClientRect();
      const small = er.width > 0 && er.width <= 40 && er.height <= 40;   // 只认小图标
      if (small && (greenish(st.color) || greenish(st.fill))) return true;
      // 底色要小面积才算标记：整行的选中底色块、标题文字颜色都不算
      const big = er.width > rr.width * 0.5 && er.height > 10;
      if (!big && small && greenish(st.backgroundColor)) return true;
    }
    return false;
  }

  // 浅色绿底（选中行的胶囊底色）单独认一遍：它亮度高，和“对勾绿”不是一个区间
  function tintedGreen(color) {
    const c = rgbOf(color);
    if (!c || c.a < 0.15) return false;
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return h >= 80 && h <= 175 && s >= 0.25 && l >= 0.72;
  }

  // 当前正在看的是哪一行：2 = 很确定（类名/浅绿底），1 = 有底色但不确定（可能是鼠标悬停），0 = 不像
  function rowActive(row) {
    if (/active|selected|current|focus/i.test(String(row.className || ''))) return 2;
    if (row.getAttribute('aria-selected') === 'true') return 2;
    const rr = row.getBoundingClientRect();
    let score = 0;
    for (const el of [row, ...row.querySelectorAll('div,span,a,li')]) {
      let st;
      try { st = getComputedStyle(el); } catch (e) { continue; }
      const c = rgbOf(st.backgroundColor);
      if (!c || c.a < 0.3) continue;
      // 标签（视频/作业）太窄，整行宽的色块才是选中态
      const er = el.getBoundingClientRect();
      if (er.width < rr.width * 0.55 || er.height < 12) continue;
      if (c.r > 245 && c.g > 245 && c.b > 245) continue;    // 白底跳过
      if (tintedGreen(st.backgroundColor)) return 2;
      score = 1;
    }
    return score;
  }

  // 右侧详情区的标题栏文本（含“考核截止时间”的那一条），用来兜底认“当前行”。
  // 目录行不一定带 node_id，高亮类名也不一定稳定，这条通常最可靠：
  // 目录里的「视频 5.5 如何高效率管理文献（四）」和标题栏里的标题是同一串字。
  function pageNodeTitle() {
    let best = '';
    for (const el of document.querySelectorAll('div,span,p,section,header')) {
      const t = norm(el.textContent);
      if (!t || t.length > 220 || t.indexOf('考核截止时间') === -1) continue;
      if (inSidebar(el)) continue;
      if (!best || t.length < best.length) best = t;   // 取最紧凑的那条
    }
    return best;
  }

  function doTocScan() {
    const panel = tocPanel();
    if (!panel) return null;

    const rows = [];
    const seen = [];
    for (const el of panel.querySelectorAll('div,li,a,span,p')) {
      const t = norm(el.textContent);
      if (!t || t.length > 70) continue;
      const isTag = TAG_RE.test(t);
      const isChap = !isTag && CHAP_RE.test(t);
      const isNum = !isTag && !isChap && NUMROW_RE.test(t);
      if (!isTag && !isChap && !isNum) continue;
      if (!visible(el)) continue;
      const row = rowOfEl(el, panel);
      // 行内元素（类型胶囊「视频」、标题文字）不能被当成独立的一行：
      // 它们各自也满足“行首是标签/编号”，早期版本因此把一个视频数成两三行，
      // 于是“还剩 N 节”翻倍、跳转目标也可能落到一个点不动的胶囊上。
      if (seen.some(r => r === row || r.contains(row))) continue;
      seen.push(row);

      const rt = norm(row.textContent);
      const tm = rt.match(TAG_RE);
      rows.push({
        el: row,
        text: rt,
        tag: tm ? tm[1] : '',
        title: tm ? rt.replace(TAG_RE, '').trim()
                   : (rt.replace(CHAP_RE, '').trim() || rt),
        chapter: isChap,
        group: isNum,
        playable: !!tm && PLAY_TAGS.test(tm[1]),
        done: false,
        fold: false,
        loose: false,
        key: rowKey(row),
      });
    }
    if (rows.length < 3) return null;

    const rects = rows.map(r => r.el.getBoundingClientRect());
    rows.forEach((r, i) => { r.done = rowDone(r.el, rects[i]); });

    // 折叠判定：章节 / 带编号的知识点行，如果紧跟着的还是同类行（或者到末尾了），
    // 说明它下面什么都没展开。这种行要当成“兜底候选”——里面很可能还藏着视频。
    rows.forEach((r, i) => {
      if (r.chapter || r.group) {
        const nx = rows[i + 1];
        r.fold = !nx || nx.chapter || nx.group;
      }
      r.loose = !r.playable && (r.group || (r.chapter && r.fold));
    });

    // 知识点行自己不显示对勾。如果它展开后列出的视频全都完成了，就把它也当成完成，
    // 省得为了一个空壳的知识点首页白跑一趟（一次要等十几秒）。
    for (let i = 0; i < rows.length; i++) {
      const g = rows[i];
      if (!g.group || g.fold || g.done) continue;
      let any = false, allDone = true;
      for (let j = i + 1; j < rows.length; j++) {
        const ch = rows[j];
        if (ch.chapter || ch.group) break;
        any = true;
        if (!ch.done) { allDone = false; break; }
      }
      if (any && allDone) g.done = true;
    }

    // 每行归到它上面最近的「第N章/节」下：用来实现“先看完当前这一节”
    let chap = null;
    for (const r of rows) {
      if (r.chapter) chap = r;
      r.chap = chap;
      r.chapTitle = chap ? chap.title : '';
    }

    let current = null;
    let how = '';
    const nid = (location.search.match(/node_id=(\d+)/) || [])[1];
    if (nid) { current = rows.find(r => r.key === 'n' + nid) || null; if (current) how = 'node'; }
    if (!current) { current = rows.find(r => rowActive(r.el) === 2) || null; if (current) how = 'active'; }
    if (!current) { current = rows.find(r => rowActive(r.el) === 1) || null; if (current) how = 'hover'; }
    if (!current) {
      // 用标题栏的标题反查目录行：取最长的匹配行，避免“第5节”这种前缀行抢先命中
      const banner = pageNodeTitle();
      if (banner) {
        let best = null, bestLen = 0;
        for (const r of rows) {
          if ((!r.playable && !r.group) || !r.title) continue;
          if (banner.indexOf(r.title) === -1) continue;
          if (r.title.length > bestLen) { bestLen = r.title.length; best = r; }
        }
        current = best;
        if (current) how = 'title';
      }
    }
    S.currentHow = current ? how : '';

    return { panel, rows, current, scanAt: Date.now() };
  }

  function tocScan(force) {
    const now = Date.now();
    if (!force && S.tocCache && now - S.tocCacheAt < CFG.tocScanTtlMs) return S.tocCache;
    let st = null;
    try { st = doTocScan(); } catch (e) {
      console.log('%c[雨课堂自动连播] 目录读取失败：' + (e && e.message), 'color:#9a6700');
    }
    S.tocCache = st;
    S.tocCacheAt = now;
    return st;
  }

  // 还没看完、且这次会话还没试过（或软标记已经过期）的行。
  // 除视频行外，带编号的知识点行 / 没展开的章节也算候选（loose），
  // 否则折叠起来的那些视频根本没有机会被选中。
  function tocCandidates(st) {
    const now = Date.now();
    const seen = {};
    const out = [];
    for (const r of st.rows) {
      if (!r.playable && !r.loose) continue;
      if (r.done) continue;
      if (r === st.current) continue;      // 已经在看的这一行不算候选，否则会点到自己
      if (S.tried.has(r.key)) continue;
      const at = S.triedAt.get(r.key) || 0;
      if (at && now - at < CFG.softRetryMs) continue;
      if (seen[r.key]) continue;
      seen[r.key] = 1;
      out.push(r);
    }
    return out;
  }

  function shortTitle(t) {
    t = String(t || '').replace(/^[\d.\s、]+/, '');
    return t.length > 14 ? t.slice(0, 14) + '…' : t;
  }

  // 标记“当前这一节已经处理过”，分两级：
  //   硬（S.tried）  ：平台确认已完成 / 折叠节点已经进去翻过——本轮不再回头
  //   软（S.triedAt）：试过但没确认完成（99% 卡住、超时跳过、播放拉不起来…），
  //                   过了 softRetryMs 还要回来补。旧版全用硬标记，于是这些
  //                   没收尾的视频本轮再也不会被选中，看起来就是“被漏掉了”。
  function markTriedCurrent() {
    const now = Date.now();
    const nid = (location.search.match(/node_id=(\d+)/) || [])[1];
    const st = S.tocCache || tocScan();
    const keys = [];
    if (nid) keys.push('n' + nid);
    // 目录里的“当前行”只有在认得准时才算数（node_id 命中 / 强选中态）。
    // 靠悬停底色或标题模糊匹配猜出来的行不能拿来标记，否则会把别的未完成视频锁死。
    if (st && st.current && st.current.key &&
        (S.currentHow === 'node' || S.currentHow === 'active') &&
        st.current.key !== 'n' + nid) {
      keys.push(st.current.key);
    }
    const curb = st && st.current;
    const hard = !!(curb && (curb.done || curb.loose));
    for (const k of keys) {
      if (hard) { S.tried.add(k); S.triedAt.delete(k); }
      else if (!S.tried.has(k)) S.triedAt.set(k, now);
    }
    if (keys.length) {
      console.log('%c[雨课堂自动连播] 记下这一段' +
                  (hard ? '（已确认，不再回头）' : '（还没确认完成，稍后回补）') +
                  '：' + keys.join(','), 'color:#0969da');
    }
  }

  // 按「最近」挑一个未完成视频跳过去。返回 true 表示已经动手。
  function tocJump(reason) {
    if (!CFG.tocEnabled) return false;
    const now = Date.now();
    if (S.tocOffUntil && now < S.tocOffUntil) return false;
    if (now - S.lastTocJumpAt < CFG.tocJumpCooldownMs) return false;

    const st = tocScan();      // 用缓存（20 秒），别每个来回都全量扫一遍目录
    if (!st) return false;                         // 读不到目录：交给「下一个知识点」

    const cands = tocCandidates(st);
    if (!cands.length) {
      S.lastTocJumpAt = now;                     // 别每 3 秒重新扫一遍目录

      // ① 先做一轮回补：把软标记清掉（当前这一节留着，免得原地打转），
      //    滚回目录顶部重扫。10 分钟才做一次，不然会在整个目录里来回跳。
      if (!S.backfillAt || now - S.backfillAt > CFG.backfillMs) {
        S.backfillAt = now;
        S.triedAt.clear();
        const cnid = (location.search.match(/node_id=(\d+)/) || [])[1];
        if (cnid) S.triedAt.set('n' + cnid, now);
        try { st.panel.scrollTop = 0; } catch (e) {}
        S.tocCache = null; S.tocCacheAt = 0;
        console.log('%c[雨课堂自动连播] 目录里已没有未完成的视频，清掉软记录回补一遍',
                    'color:#1a7f37');
        return true;
      }

      // ② 回补也没补出东西：让平台的「下一个知识点」探一次路（它认得折叠的节点）
      if (!S.probeAt || now - S.probeAt > CFG.backfillMs) {
        S.probeAt = now;
        console.log('%c[雨课堂自动连播] 目录里没有候选，让平台的「下一个知识点」探一次',
                    'color:#0969da');
        return false;
      }

      // ③ 探也探过了：安静守着，别再点按钮干耗
      endQuiet('目录里已经没有未完成的视频了');
      return true;
    }

    const idxOf = new Map(st.rows.map((r, i) => [r, i]));
    const cur = st.current;
    const curIdx = cur && idxOf.has(cur) ? idxOf.get(cur) : -1;
    const curChap = cur ? cur.chap : null;

    // 在一组候选里挑最近的：往后有就取往后最近的一个，否则取前后距离最近的
    const nearest = (list) => {
      if (!list.length) return null;
      if (curIdx < 0) return list[0];
      const ahead = list.filter(r => idxOf.get(r) > curIdx);
      if (ahead.length) return ahead[0];
      return list.reduce((a, b) =>
        Math.abs(idxOf.get(b) - curIdx) < Math.abs(idxOf.get(a) - curIdx) ? b : a);
    };
    const aheadOf = (list) => (curIdx >= 0 ? list.filter(r => idxOf.get(r) > curIdx) : list);

    const solid = cands.filter(r => !r.loose);      // 明确是“未完成的视频”行
    const loose = cands.filter(r => r.loose);       // 还没展开、不知道里面有什么的行

    // 顺序：本节没看完的视频 → 往后最近的未完成视频 → 本节没展开的节点 →
    //       往后没展开的节点 → 回头补漏（视频优先，其次折叠节点）
    const tries = [
      [curChap ? solid.filter(r => r.chap === curChap) : [], '本节还有没看完的视频'],
      [aheadOf(solid), '本节已看完，跳到最近的未完成视频'],
      [curChap ? loose.filter(r => r.chap === curChap) : [], '本节还有没展开的知识点，进去看看'],
      [aheadOf(loose), '目录里没列出视频，进去没展开的节点看看'],
      [solid, '回头补漏下的视频'],
      [loose, '回头补漏下没展开的节点'],
    ];
    let target = null, rule = '';
    for (const item of tries) {
      if (target) break;
      const t = nearest(item[0]);
      if (t) { target = t; rule = item[1]; }
    }
    if (!target) { target = cands[0]; rule = '目录里唯一剩下的'; }

    const key = target.key, before = location.href;
    S.lastTocJumpAt = now;
    S.lastJumpHref = before;
    S.triedAt.set(key, now);        // 软标记：跳过去以后要是没看完，过一阵还会回来
    console.log('%c[雨课堂自动连播] 目录共 ' + st.rows.length + ' 行，未完成视频 ' +
                cands.length + ' 个 → ' + rule + '：「' + target.title + '」（' + reason + '）',
                'color:#0969da');
    badge('正在跳到「' + shortTitle(target.title) + '」', 'ok');

    try { target.el.scrollIntoView({ block: 'center' }); } catch (e) {}
    const spots = jumpTargets(target.el);
    let si = 0;
    const poke = () => {
      if (location.href !== before || si >= spots.length) return;
      fireClick(spots[si++]);
      setTimeout(() => { if (location.href === before) poke(); }, 700);
    };
    poke();

    // 点了没跳：把这一条放回去，下次换一个试；连续失败就把目录跳转关一会儿
    setTimeout(() => {
      if (location.href !== before) { S.tocFail = 0; return; }
      S.triedAt.delete(key);
      S.tocFail++;
      console.log('%c[雨课堂自动连播] 点了目录没反应（第 ' + S.tocFail + ' 次）',
                  'color:#9a6700');
      if (S.tocFail >= CFG.tocMaxFail) {
        S.tocOffUntil = Date.now() + 600000;
        console.log('%c[雨课堂自动连播] 连续点不动目录，10 分钟内改回点「下一个知识点」',
                    'color:#9a6700');
      }
    }, 8000);

    return true;
  }

  // 目录行的点击落点。行的点击处理器不一定挂在我们取到的那个 div 上，
  // 所以按“真实鼠标点下去会打中谁”的顺序排：行中心最里层元素 → 行本身 → 最内层文字节点。
  // 依次试，跳走了就停，避免一下点出两次跳转。
  function jumpTargets(row) {
    const out = [];
    const push = (el) => { if (el && el.nodeType === 1 && out.indexOf(el) === -1) out.push(el); };
    try {
      const r = row.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width * 0.35, r.top + r.height / 2);
      if (hit && (hit === row || row.contains(hit))) push(hit);
    } catch (e) {}
    push(row);
    let leaf = row;
    for (;;) {
      const t = norm(row.textContent);
      const child = Array.from(leaf.children).find(c => norm(c.textContent) === t);
      if (!child) break;
      leaf = child;
    }
    push(leaf);
    return out;
  }

  // 换节的统一入口：先试目录跳转，不行再点「下一个知识点」。
  // 刚点过目录就先等它生效——否则两个动作叠在一起会一次跳两节。
  function advance(reason) {
    const now = Date.now();
    if (now - S.lastTocJumpAt < CFG.tocJumpCooldownMs + 5000) {
      // 刚点过目录就先等它生效——否则两个动作叠在一起会一次跳两节。
      // 已经“看完了在安静守着”的时候不要再刷状态条，免得把结论盖掉。
      if (!(S.endScanAt && now - S.endScanAt < CFG.endRescanMs)) badge('正在跳到下一节…', 'ok');
      return true;
    }
    if (tocJump(reason)) return true;
    return clickNext(reason);
  }

  // 目录里确实没有未完成视频了：别再反复戳平台按钮，安静守着，隔一阵重扫回补
  function endQuiet(reason) {
    const now = Date.now();
    if (S.endScanAt && now - S.endScanAt < CFG.endRescanMs) { badge(reason, 'ok'); return; }
    S.endScanAt = now;
    console.log('%c[雨课堂自动连播] ' + reason + '，' + (CFG.endRescanMs / 1000) +
                ' 秒后再核对一遍目录', 'color:#1a7f37');
    badge(reason, 'ok');
    setTimeout(() => {
      S.triedAt.clear();
      S.tocCache = null; S.tocCacheAt = 0;
      S.endScanAt = 0;
      S.enabled = true;
      tick();
    }, CFG.endRescanMs);
  }

  // 目录里的候选都试完了吗（用来判断“是真的看完了”还是“还没试到”）
  function tocSaysDone() {
    const st = tocScan();
    if (!st) return false;
    return tocCandidates(st).length === 0;
  }

  // 本节点“重新进入”的次数。存在 sessionStorage 里，刷新页面也不归零——
  // 否则一个永远起不来的视频页会陷入「刷新 → 等 90 秒 → 刷新」的死循环。
  function reenterCount(nid) {
    if (!nid) return 0;
    try { return parseInt(sessionStorage.getItem('yt_ap_re_' + nid) || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function bumpReenter(nid) {
    if (!nid) return;
    try { sessionStorage.setItem('yt_ap_re_' + nid, String(reenterCount(nid) + 1)); } catch (e) {}
  }

  // 重新进入当前节点：先点目录里自己那一行，点不动就刷新。
  function reenterNode() {
    const before = location.href;
    const st = tocScan(true);
    if (st && st.current) {
      try { st.current.el.scrollIntoView({ block: 'center' }); } catch (e) {}
      const spots = jumpTargets(st.current.el);
      if (spots.length) fireClick(spots[0]);
    }
    setTimeout(() => {
      if (location.href === before) {
        console.log('%c[雨课堂自动连播] 重新进入没反应，直接刷新本页', 'color:#9a6700');
        try { location.reload(); } catch (e) {}
      }
    }, 4000);
  }

  // 控制台里列一份目录清单（Alt+D），核对“它到底认为哪些没看完”
  function dumpToc() {
    const st = tocScan(true);
    if (!st) {
      console.log('%c[雨课堂自动连播] 没读到左侧目录，可能是收起了。不影响播放',
                  'color:#9a6700');
      return;
    }
    const cur = st.current;
    console.table(st.rows.map((r, i) => ({
      序号: i + 1,
      类型: r.playable ? (r.tag || '视频')
            : r.chapter ? (r.fold ? '章节(未展开)' : '章节')
            : r.group ? (r.fold ? '知识点(未展开)' : '知识点')
            : (r.tag || '其他'),
      标题: r.title.slice(0, 40),
      已完成: r.done ? '✓' : '',
      当前位置: r === cur ? '←' : '',
      已试过: S.tried.has(r.key) ? '已确认' : (S.triedAt.has(r.key) ? '待回补' : ''),
    })));
    console.log('%c[雨课堂自动连播] 共 ' + st.rows.length + ' 行，未完成视频 ' +
                st.rows.filter(r => r.playable && !r.done).length + ' 个',
                'color:#0969da');
  }

  // ---------- 主循环 ----------
  let lastTickAt = 0;

  // 事件触发的快速检查：DOM 变化 / 媒体事件不受后台节流影响，
  // 所以即使定时器被浏览器压到 1 分钟一次，这里也能秒级响应。
  // ============================================================
  // 完成确认：防止“一节里有多个视频，只播完第一个就切走”
  //
  // 平台把完成度按【整个知识点】算，但一个知识点下可以挂多段视频：
  // 第一段播完的一瞬间完成度就跳到 100%，随后播放器才去接第二段。
  // 早先的版本看到 100% 就切，第二段整段被丢掉。
  //
  // 现在四道闸一起挡：
  //   1. URL 里 video id 变了（同一节换片）→ 40 秒内一律不切
  //   2. 播放器里还有没播完的片（在播 / 还没起播）→ 先等，最多等 90 秒
  //   3. 播放器指纹变了且仍在播 → 认为接到了新片，重新计时
  //   4. 完成标记出现后压 6 秒仍无动静 → 才算这一节真看完
  // ============================================================
  function playbackSignal() {
    const vs = Array.from(document.querySelectorAll('video'));
    if (!vs.length) return '';
    return vs.map(v => Math.round(v.currentTime || 0) + (v.paused ? 'p' : 'r') + (v.ended ? 'E' : '')).join('|');
  }

  function anyPlaying() {
    return Array.from(document.querySelectorAll('video'))
      .some(v => !v.paused && !v.ended && (v.currentTime || 0) > 0.5);
  }

  function finishConfirmed(where) {
    const now = Date.now();
    const sig = playbackSignal();

    // 一进页面就已经是「已完成」的节点：直接过，别在这儿循环重看
    if (!S.nearEnd) return true;

    // 这一节里刚换过片：新视频可能要几十秒才起来，这段时间完成度显示什么都不算数
    if (S.segChangedAt && now - S.segChangedAt < CFG.segGraceMs) {
      if (!S.segGraceLogged) {
        S.segGraceLogged = true;
        console.log('%c[雨课堂自动连播] 本节还有视频没放完，等它接上再判断', 'color:#0969da');
      }
      return false;
    }

    if (!S.finishFirstAt) S.finishFirstAt = now;

    // 兜底：压了 3 分钟还在播，说明是真长视频续播，放行，不要一直挂着
    if (now - S.finishFirstAt > 180000) {
      console.log('%c[雨课堂自动连播] 完成标记已存在 3 分钟，强制切节', 'color:#9a6700');
      S.finishFirstAt = 0;
      S.pendingSince = 0;
      return true;
    }

    // 播放器里还有没播完的片子（正在播、或者停在 0 秒还没加载出来）就别切。
    // 一节挂多段视频时，第一段播完到第二段起来中间有几秒空档，这里正好挡住。
    // 但最多挡 90 秒——万一播放器坏了，不能把整晚耗在等它起播上。
    let pending = false;
    for (const v of document.querySelectorAll('video')) {
      if (v.ended) continue;
      if (v.readyState < 2 || !v.paused) { pending = true; break; }
    }
    if (!pending) {
      S.pendingSince = 0;
    } else {
      if (!S.pendingSince) S.pendingSince = now;
      if (now - S.pendingSince < 90000) {
        S.finishSeenAt = now;
        return false;
      }
      console.log('%c[雨课堂自动连播] 等新视频起播超过 90 秒，不再等，按已完成处理',
                  'color:#9a6700');
    }

    if (!S.finishSeenAt) {
      S.finishSeenAt = now;
      S.finishSig = sig;
      console.log('%c[雨课堂自动连播] 出现完成标记（' + where + '），先观察 ' +
                  (CFG.finishConfirmMs / 1000) + ' 秒，确认没有后续视频',
                  'color:#0969da');
      return false;
    }

    // 指纹变了 + 还在播 = 播放器接到了下一段，取消切换
    if (sig && S.finishSig && sig !== S.finishSig && anyPlaying()) {
      console.log('%c[雨课堂自动连播] 播放器换到下一段视频了，继续观看（不切节）', 'color:#0969da');
      S.finishSeenAt = 0;
      S.finishSig = '';
      return false;
    }

    // 完成标记出现后播放器仍在播，也当作还有内容
    if (anyPlaying()) {
      S.finishSeenAt = now;      // 持续压着，不切
      return false;
    }

    return now - S.finishSeenAt >= CFG.finishConfirmMs;
  }

  function tickSoon() {
    const now = Date.now();
    if (now - lastTickAt < 1000) return;   // 合并高频触发
    tick();
  }

  function tick() {
    lastTickAt = Date.now();
    const nid = (location.search.match(/node_id=(\d+)/) || [])[1] || '';
    const vid = (location.pathname.match(/\/video\/(\d+)/) || [])[1] || '';
    const nodeToken = nid || location.href;

    if (nodeToken !== S.nodeId) {
      // 换了一节：整套状态重置
      S.nodeId = nodeToken;
      S.videoId = vid;
      S.segChangedAt = 0;
      S.segGraceLogged = false;
      S.lastHref = location.href;
      S.repeatClicks = 0;
      S.retryCount = 0;
      S.stallNudges = 0;
      S.learnClicks = 0;
      S.noNodeSince = 0;
      S.lastPct = -1;
      S.nearEnd = false;
      S.finishSeenAt = 0;
      S.finishFirstAt = 0;
      S.finishSig = '';
      S.tocCache = null;          // 换了节点，目录里的“当前位置”跟着变
      S.tocCacheAt = 0;
      S.learnHref = '';           // 新节点允许再点一次「去学习」
      S.endScanAt = 0;
    } else if (vid && S.videoId && vid !== S.videoId) {
      // 同一节里换到了另一段视频：这一节还没看完，绝对不能切节。
      // 之前就是这里出问题——URL 的 video id 一变就被当成“新节点”重置，
      // 完成度还挂在 100%，于是立刻被判定为“已完成”直接跳走，后面的视频整段丢掉。
      S.videoId = vid;
      S.lastHref = location.href;
      S.segChangedAt = Date.now();
      S.segGraceLogged = false;
      S.lastPct = -1;
      S.pctSeenAt = 0;
      S.nearEnd = true;          // 明确：这一节还有内容
      S.finishSeenAt = 0;
      S.finishFirstAt = 0;
      S.finishSig = '';
      S.noNodeSince = 0;
      S.learnClicks = 0;
      S.repeatClicks = 0;
      S.pendingSince = 0;
      S.tocCache = null;
      S.tocCacheAt = 0;
      console.log('%c[雨课堂自动连播] 同一节里换到下一段视频（' + vid + '），继续看，不切节',
                  'color:#0969da');
      badge('本节还有视频，继续播放', 'playing');
    } else if (vid) {
      S.videoId = vid;
      S.lastHref = location.href;
    }
    if (!S.enabled) return;

    applySpeed();

    const pct = readNodePct();
    // 刚跳到新节点时的第一次读数：用来发现“目录把已完成的节点当成未完成”
    const firstLook = S.lastPct < 0;

    if (pct === null) {
      // 知识点首页没有「完成度：xx%」，但通常有「去学习」——必须先点进去，
      // 不能直接当作业节点跳过。旧版就是在这一步漏了，会白白跳过整节视频。
      if (goLearn()) {
        badge('正在进入视频…', 'idle');
        S.noNodeSince = 0;
        return;
      }

      // 节点学完后平台把「完成度：100%」换成「已完成」
      if (findText('已完成', true)) {
        S.noNodeSince = 0;
        if (!finishConfirmed('标题显示已完成')) {
          badge('本节已完成，确认中…', 'ok');
          return;
        }
        markTriedCurrent();
        badge('本节已完成，切换下一节', 'ok');
        advance('节点显示已完成');
        return;
      }

      // 知识点首页写着「学习单元完成情况 1/1」= 这里的视频都看完了，
      // 不用干等 25 秒超时（一节一个知识点，折叠的知识点很多这种页）
      if (unitsAllDone()) {
        S.noNodeSince = 0;
        if (!finishConfirmed('学习单元全部完成')) { badge('本节已完成，确认中…', 'ok'); return; }
        markTriedCurrent();
        badge('本节已完成，切换下一节', 'ok');
        advance('学习单元全部完成');
        return;
      }

      // 剩下的都是没完成度的页面。先认清是什么，再按类型给不同的等待时长，
      // 不再一律空等 120 秒——那正是「看着像卡死」的根源。
      const kind = classifyNoContent();
      let limit = kind === 'hw' ? CFG.hwSkipMs
                : kind === 'home' ? CFG.homeSkipMs
                : CFG.unknownSkipMs;

      // 明确就是视频节点（卡片上写着「视频」/ 目录当前行是视频 / 有播放器）：
      // 完成度只是还没渲染出来，绝不能用“无需观看”的短超时把整节跳掉。
      const isVid = looksLikeVideoNode(tocScan());
      if (isVid) limit = Math.max(limit, CFG.videoNodeGraceMs);
      if (kind !== 'hw' && document.querySelector('video')) limit = Math.max(limit, 60000);

      if (!S.noNodeSince) S.noNodeSince = Date.now();
      const waited = Date.now() - S.noNodeSince;

      if (waited >= limit) {
        // 视频页一直读不到完成度：先重新进一次（点回目录行 / 刷新），别把整节扔掉
        const nid = (location.search.match(/node_id=(\d+)/) || [])[1] || '';
        if (isVid && reenterCount(nid) < CFG.videoReenterMax) {
          bumpReenter(nid);
          S.noNodeSince = 0;
          console.log('%c[雨课堂自动连播] 视频页一直没出现完成度，重新进入一次（第 ' +
                      reenterCount(nid) + ' 次）', 'color:#9a6700');
          badge('视频还没起来，正在重新进入…', 'warn');
          reenterNode();
          return;
        }
        S.noNodeSince = Date.now();          // 重新计时，等下一次尝试
        rememberSkip(kind);
        markTriedCurrent();
        advance('跳过' + KIND_LABEL[kind]);
        return;
      }

      // 状态条写清楚在等什么、还剩几秒，别只丢一句「等待节点加载」
      const left = Math.max(1, Math.ceil((limit - waited) / 1000));
      badge((isVid ? '视频还在加载' : '此页无需观看') + ' · ' + left + ' 秒后跳过', 'idle');
      return;
    }
    S.noNodeSince = 0;

    // 完成度长时间不动 = 播放被暂停了。这里全部自动处理，不要求人去点播放器：
    // 播放器在 iframe 里，那边的脚本每 2 秒拉一次；顶层只负责在主文档试一次，
    // 然后把状态写清楚。
    if (pct !== S.lastPct) {
      S.lastPct = pct;
      S.pctSeenAt = Date.now();
      S.stallNudges = 0;
      if (pct > 0 && pct < CFG.finishPct) S.tocWrong = 0;   // 这一节确实有进度，目录没认错
      if (pct >= 90) S.nearEnd = true;   // 本页确实播到过接近完成
    } else if (pct < CFG.finishPct && S.pctSeenAt &&
               Date.now() - S.pctSeenAt > CFG.stallWarnMs) {
      tryResume();                    // 主文档里有 video 就直接拉
      S.stallNudges++;
      if (quizBlocker()) {
        badge('有弹窗，正在处理（' + pct + '%）', 'warn');
      } else {
        badge('正在恢复播放（第 ' + S.stallNudges + ' 次）', 'warn');
      }
      // 一直起不来就换下一节，别把整晚耗在一节上
      if (S.stallNudges >= 5) {
        markTriedCurrent();
        advance('长时间无法恢复播放（' + pct + '%）');
      } else { S.pctSeenAt = Date.now(); return; }
    }

    if (pct >= CFG.finishPct) {
      // 一进来就是 100%：说明目录把它算成未完成了，跳过来等于白跑一趟
      if (firstLook && S.lastTocJumpAt && Date.now() - S.lastTocJumpAt < 90000 &&
          S.lastJumpHref && S.lastJumpHref !== location.href) {
        S.tocWrong++;
        console.log('%c[雨课堂自动连播] 目录把这个已完成节点当成未完成了（第 ' +
                    S.tocWrong + ' 次）', 'color:#9a6700');
        if (S.tocWrong >= 3) {
          S.tocOffUntil = Date.now() + 600000;
          console.log('%c[雨课堂自动连播] 目录的完成标记认不准，10 分钟内改回点「下一个知识点」',
                      'color:#9a6700');
        }
      }
      if (!finishConfirmed('完成度 ' + pct + '%')) {
        badge('本节已完成，确认中…', 'ok');
        return;
      }
      markTriedCurrent();
      badge('本节已完成，切换下一节', 'ok');
      advance('完成度 ' + pct + '%');
      return;
    }

    // 有明显“去学习”入口说明还在知识点首页
    if (goLearn()) {
      badge('正在进入视频…', 'idle');
      return;
    }

    const lp = localPaused();
    // 技术诊断只留在控制台，状态条上只讲“现在在干什么”
    if (!S.pinned && !S.pinWarned) {
      S.pinWarned = true;
      console.warn('[雨课堂自动连播] pause() 拦截未安装，需要重新加载扩展');
    }
    if (lp === true) {
      badge('正在继续播放（' + pct + '%）', 'warn');
      return;
    }
    // 顺手把“还剩几节视频”带到第二行（走目录缓存，不会因此反复扫 DOM）
    const st = tocScan();
    if (st) {
      const left = st.rows.filter(r => r.playable && !r.done).length;
      if (left !== S.leftCount) { S.leftCount = left; updateTip(); }
    }
    badge('正在播放 ' + pct + '%', 'playing');
  }

  // ---------- 状态条 ----------
  let badgeEl, badgeTxt, tipEl;
  function ensureBadge() {
    if (!IS_TOP) return;
    if (badgeEl && document.body.contains(badgeEl)) return;
    badgeEl = document.createElement('div');
    badgeEl.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
      'font:12px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:8px;' +
      'padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.12);max-width:280px;user-select:none';
    badgeTxt = document.createElement('div');
    badgeTxt.textContent = '自动连播：启动中…';
    badgeEl.appendChild(badgeTxt);

    tipEl = document.createElement('div');
    tipEl.style.cssText = 'margin-top:4px;color:#0969da;cursor:pointer;font-size:11px';
    tipEl.onclick = toggle;
    badgeEl.appendChild(tipEl);
    updateTip();

    document.body.appendChild(badgeEl);
  }

  function badge(text, kind) {
    if (!IS_TOP || !badgeEl) return;
    if (text === S.lastMsg) return;
    S.lastMsg = text;
    badgeTxt.textContent = '自动连播 · ' + text;
    badgeTxt.style.color =
      kind === 'warn' ? '#9a6700' : kind === 'ok' ? '#1a7f37' :
      kind === 'playing' ? '#0969da' : '#57606a';
  }

  // silent = 只写控制台，不上状态条。
  // 状态条是给人看“现在在干什么”的，不放日志味的技术措辞。
  function note(msg, kind, silent) {
    console.log('%c[雨课堂自动连播] ' + msg, 'color:' + (kind === 'warn' ? '#9a6700' : '#0969da'));
    if (IS_TOP && !silent) badge(msg, kind || 'idle');
  }

  function toggle() {
    if (S.userPaused) {
      S.userPaused = false;
      S.enabled = true; S.stopReason = ''; S.repeatClicks = 0; S.noNodeSince = 0;
      resumeNow();
      updateTip();
      badge('继续自动连播', 'playing');
    } else {
      S.userPaused = true;
      S.enabled = false;
      updateTip();
      badge('已暂停', 'idle');
    }
  }

  // Alt+P 恢复时立刻拉一把，不用等保活那 2 秒
  function resumeNow() {
    document.querySelectorAll('video').forEach(v => {
      if (v.ended) return;
      v.__apPausedAt = 0;
      try {
        const p = v.play();
        if (p && p.catch) p.catch(() => {
          try { v.muted = true; v.play().catch(() => {}); } catch (e) {}
        });
      } catch (e) {}
    });
  }

  // ---------- 轮询间隔：查看 / 修改 ----------
  function fmtMs(ms) {
    return ms >= 1000 ? (ms / 1000) + ' 秒' : ms + ' 毫秒';
  }

  function updateTip() {
    if (!tipEl) return;
    tipEl.textContent = (S.userPaused ? '点击这里继续' : '点击这里暂停') +
      (S.leftCount === null ? '' : ' · 还剩 ' + S.leftCount + ' 节') + ' · ' + VER;
  }

  let timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, CFG.pollMs);
  }

  function setPoll(ms) {
    const n = Math.max(CFG.pollMinMs, Math.min(CFG.pollMaxMs, ms));
    if (n === CFG.pollMs) return;
    CFG.pollMs = n;
    try { localStorage.setItem('yt_autoplay_poll', String(n)); } catch (e) {}
    schedule();
    updateTip();
    console.log('%c[雨课堂自动连播] 检查间隔 ' + fmtMs(n), 'color:#0969da');
  }

  // 同源 iframe 兜底：播放器通常套在 iframe 里，顶层读不到它的 <video>。
  // 同源的可以跨进去，把同样的屏蔽和“暂停就拉起来”送进去；跨域的读不到，
  // 那种情况只能靠扩展在每一层各注入一份脚本。
  function patchFrames() {
    document.querySelectorAll('iframe').forEach(f => {
      let d, w;
      try { d = f.contentDocument; w = f.contentWindow; } catch (e) { return; }
      if (!d || !w || d.__apPatched) return;
      // 这一层已经有注入的实例在管了，就别再从顶层插一手
      try { if (d.documentElement && d.documentElement.__apInjected) return; } catch (e) { return; }
      d.__apPatched = true;
      try {
        const dp = w.Document.prototype;
        Object.defineProperty(dp, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(dp, 'visibilityState', { get: () => 'visible', configurable: true });
        d.hasFocus = () => true;
        ['visibilitychange', 'blur', 'pagehide'].forEach(t => {
          w.addEventListener(t, e => e.stopImmediatePropagation(), true);
          d.addEventListener(t, e => e.stopImmediatePropagation(), true);
        });
        // 同样把这一层 <video>.pause() 钉住，只放行播完和 Alt+P
        const mp = w.HTMLMediaElement && w.HTMLMediaElement.prototype;
        if (mp && !mp.__apPinned) {
          const origPause = mp.pause;
          mp.pause = function () {
            try { if (this.ended) return origPause.apply(this, arguments); } catch (e) {}
            if (S.userPaused) return origPause.apply(this, arguments);
            S.pauseBlocked++;
            return undefined;
          };
          mp.__apPinned = true;
        }
      } catch (e) {}
      const keep = () => {
        try {
          const now = Date.now();
          d.querySelectorAll('video').forEach(v => {
            if (!v.paused || v.ended) { v.__apPausedAt = 0; return; }
            if (!v.__apPausedAt) { v.__apPausedAt = now; return; }
            if (now - v.__apPausedAt < CFG.resumeDelayMs) return;   // 别和播放器抢
            v.__apPausedAt = 0;
            const p = v.play();
            if (p && p.catch) p.catch(() => {
              try { v.muted = true; v.play().catch(() => {}); } catch (e) {}
            });
          });
        } catch (e) {}
      };
      setInterval(keep, 2000);
    });
  }

  // ---------- 启动 ----------
  function boot() {
    ensureBadge();
    console.log('%c[雨课堂自动连播] 启动，间隔 ' + fmtMs(CFG.pollMs), 'color:#0969da');
    schedule();

    patchFrames();
    setInterval(patchFrames, 3000);

    // 视频就在本页时（大多数情况如此），每 2 秒保活：被暂停就立刻拉起来。
    // 这里只受 Alt+P 管，不受“自动换节暂停一会儿”影响——换节逻辑卡住的时候，
    // 播放本身仍然要保住。
    setInterval(() => {
      if (S.userPaused) return;        // Alt+P 停手时不再强拉
      applySpeed();
      tryResume();
    }, 2000);

    // DOM 一变就查（视频进度条每几百毫秒会刷新，正好当心跳用）
    if (document.body) {
      const mo = new MutationObserver(list => {
        for (const m of list) {
          if (badgeEl && badgeEl.contains(m.target)) continue;
          tickSoon();
          return;
        }
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // 同文档里的 <video> 结束/暂停立刻触发；跨域 iframe 读不到，靠上面的 DOM 观察
    const bindMedia = () => {
      document.querySelectorAll('video').forEach(v => {
        if (v.__apBound) return;
        v.__apBound = true;
        ['ended', 'pause', 'play', 'timeupdate'].forEach(t =>
          v.addEventListener(t, tickSoon, { passive: true }));
        // 你手动点播放 = 明确要它继续，此时自动解除“暂停放行”状态。
        // 否则会出现：Alt+P 或退避期间手动点了继续，平台一按停就又停住。
        v.addEventListener('play', () => {
          if (!S.userPaused) return;
          S.userPaused = false;
          S.enabled = true;
          S.stopReason = '';
          S.repeatClicks = 0;
          S.noNodeSince = 0;
          updateTip();
          badge('继续自动连播', 'playing');
        }, { passive: true });
      });
    };
    bindMedia();
    setInterval(bindMedia, 5000);

    if (IS_TOP) {
      // 启动后读一次目录：读到了就把“还剩几节”挂到第二行，读不到也留一句，
      // 免得“到底有没有读到目录”只能靠猜
      setTimeout(() => {
        const st = tocScan(true);
        if (!st) {
          tipEl.textContent = (S.userPaused ? '点击这里继续' : '点击这里暂停') +
                              ' · 没读到目录 · ' + VER;
          console.log('%c[雨课堂自动连播] 启动时没读到左侧目录，换节会用「下一个知识点」',
                      'color:#9a6700');
          return;
        }
        S.leftCount = st.rows.filter(r => r.playable && !r.done).length;
        updateTip();
        console.log('%c[雨课堂自动连播] 目录读取正常：共 ' + st.rows.length + ' 行，未完成视频 ' +
                    S.leftCount + ' 个' + (st.current ? '，当前在「' + st.current.title + '」'
                    : '，没认出当前位置'), 'color:#0969da');
      }, 4000);

      window.addEventListener('keydown', e => {
        if (!e.altKey) return;
        if (e.key === 'p' || e.key === 'P') { e.preventDefault(); toggle(); }
        else if (e.key === '[') { e.preventDefault(); setPoll(CFG.pollMs - 500); }
        else if (e.key === ']') { e.preventDefault(); setPoll(CFG.pollMs + 500); }
        else if (e.key === 's' || e.key === 'S') { e.preventDefault(); dumpSkipped(); }
        else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); dumpToc(); }
      });
    }
  }

  // 子框架（播放器就在这一层）：同样只做“别被暂停”，不参与换节判断。
  // 注意这里不做两件事：不对 <video> 派发点击（点击=切换播放/暂停，
  // 会和另一层的 play() 互相打架，表现就是画面反复在暂停和播放之间闪），
  // 也不刷新这一层。只调 play()，且有“暂停够久才动手 + 每分钟次数上限”。
  function bootFrame() {
    // 打个标记，顶层那边看到它就不要再跨进来管同一个视频，避免两套逻辑同时拉
    try { document.documentElement.__apInjected = true; } catch (e) {}
    const wake = () => { applySpeed(); tryResume(); };
    setInterval(wake, 2000);

    const bind = () => document.querySelectorAll('video').forEach(v => {
      if (v.__apBoundF) return;
      v.__apBoundF = true;
      ['pause', 'emptied'].forEach(t =>
        v.addEventListener(t, () => setTimeout(wake, 300), { passive: true }));
    });
    bind();
    setInterval(bind, 3000);
  }

  let started = false;
  function start() {
    if (started) return;
    if (!IS_TOP) { started = true; bootFrame(); return; }
    if (inCourse()) {
      started = true;
      console.log('%c[雨课堂自动连播] 进入课程 ' + courseIdOf() + ' · ' + VER,
                  'color:#0969da');
      boot();
      return;
    }
    // 打开的可能先是工作台首页，SPA 切进本课程后再启动
    started = true;
    let ticks = 0;
    const t = setInterval(() => {
      if (!inCourse()) {
        if (++ticks > 900) clearInterval(t);   // 半小时还没进任何课程页就不再等
        return;
      }
      clearInterval(t);
      spoofVisibility();
      pinPlayback();
      boot();
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
