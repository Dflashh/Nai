// ==UserScript==
// @name         NAI Archive
// @namespace    https://github.com/Dflashh/
// @version      1.0.0
// @description  NovelAI 컨셉·자료·메모를 한곳에 보관하고 공유하는 개인 아카이브입니다.
// @icon         https://cdn.jsdelivr.net/gh/Dflashh/Nai@main/Icon/NaiA.webp
// @downloadURL  https://raw.githubusercontent.com/Dflashh/Nai/main/Archive/NaiA.user.js
// @updateURL    https://raw.githubusercontent.com/Dflashh/Nai/main/Archive/NaiA.user.js
// @match        https://novelai.net/*
// @match        https://*.notion.site/*
// @match        https://notion.site/*
// @match        https://*.notion.so/*
// @match        https://notion.so/*
// @author       Dflashh
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      generativelanguage.googleapis.com
// @connect      oauth2.googleapis.com
// @connect      googleapis.com
// @connect      www.gstatic.com
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const APP_NAME = 'NAI Archive';
    const APP_VERSION = '1.0.0';
    const BUTTON_ID = 'nai-concept-loader-button';
    const MODAL_ID = 'nai-concept-loader-modal';
    const SETTINGS_KEY = 'naiConceptLoader.settings';
    const LIBRARY_KEY = 'naiConceptLoader.library';
    const LIBRARY_CATEGORY_KEY = 'naiConceptLoader.libraryCategories';
    const RESOURCE_KEY = 'naiConceptLoader.resources';
    const RESOURCE_CATEGORY_KEY = 'naiConceptLoader.resourceCategories';
    const MEMO_KEY = 'naiConceptLoader.memos';
    const MEMO_CATEGORY_KEY = 'naiConceptLoader.memoCategories';
    const SHARE_CODE_PREFIX = 'NAICL1:';
    const DEFAULT_MODEL = 'gemini-3.7-flash';
    const NOTION_MAX_DEPTH = 4;
    const NOTION_MAX_PAGES = 48;
    const NOTION_BROWSER_JOB_KEY = 'naiConceptLoader.notionBrowserCrawlerJob';
    const NOTION_BROWSER_MAX_WAIT_MS = 180000;
    const NOTION_BROWSER_PAGE_SETTLE_MS = 12000;

    const DEFAULT_SETTINGS = {
        provider: 'gemini',

        geminiKey: '',
        geminiModel: DEFAULT_MODEL,

        vertexJson: '',
        vertexProjectId: '',
        vertexLocation: 'global',
        vertexModel: DEFAULT_MODEL,

        firebaseConfig: '',
        firebaseBackend: 'vertex',
        firebaseLocation: 'global',
        firebaseModel: DEFAULT_MODEL,

    };

    const PAGE_WINDOW =
        typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const GM_XHR =
        typeof GM_xmlhttpRequest === 'function'
            ? GM_xmlhttpRequest
            : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
                ? GM.xmlHttpRequest.bind(GM)
                : null);

    const tokenCache = Object.create(null);
    let firebaseSdkPromise = null;
    const firebaseAppCache = Object.create(null);
    const firebaseAiCache = Object.create(null);
    const firebaseModelCache = Object.create(null);

    let analysisResults = [];
    let analysisMeta = null;
    let isAnalyzing = false;
    let analysisStatusText = '';
    let analysisUrl = '';
    let analysisResultUnread = false;
    const ANALYSIS_STATE_EVENT = 'nai-concept-loader-analysis-state';

    function notifyGlobalAnalysisState() {
        syncGlobalAnalyzeUi();
        try {
            document.dispatchEvent(new CustomEvent(ANALYSIS_STATE_EVENT));
        } catch (_) {}
    }

    function setGlobalAnalysisStatus(message) {
        analysisStatusText = String(message || '');

        const status = document.querySelector(
            `#${MODAL_ID} #nai-import-status`
        );
        if (status) status.textContent = analysisStatusText;
    }

    function triggerAnalysisCompletionAnimation() {
        analysisResultUnread = true;
        syncGlobalAnalyzeUi();
    }

    function acknowledgeAnalysisCompletion() {
        if (!analysisResultUnread) return;
        analysisResultUnread = false;
        syncGlobalAnalyzeUi();
    }

    function syncGlobalAnalyzeUi() {
        const modal = document.getElementById(MODAL_ID);
        const button = modal?.querySelector('[data-action="analyze"]');

        if (button) {
            button.disabled = isAnalyzing;
            button.innerHTML = isAnalyzing
                ? '<span class="nai-loading">분석 중</span>'
                : 'URL 가져오기';
        }

        const status = modal?.querySelector('#nai-import-status');
        if (status && analysisStatusText) {
            status.textContent = analysisStatusText;
        }

        const urlInput = modal?.querySelector('#nai-import-url');
        if (urlInput && analysisUrl && !urlInput.value.trim()) {
            urlInput.value = analysisUrl;
        }

        const navButton = document.getElementById(BUTTON_ID);
        if (navButton) {
            if (!navButton.querySelector('.nai-nav-diamond')) {
                navButton.innerHTML = '<span class="nai-nav-diamond" aria-hidden="true">✦</span>';
            }
            navButton.classList.toggle('nai-analyzing', isAnalyzing);
            navButton.classList.toggle(
                'nai-analysis-complete',
                !isAnalyzing && analysisResultUnread
            );

            const navLabel = isAnalyzing
                ? `${APP_NAME} · 백그라운드 분석 중`
                : analysisResultUnread
                    ? `${APP_NAME} · 분석 완료 · 확인 필요`
                    : APP_NAME;

            navButton.title = navLabel;
            navButton.setAttribute('aria-label', navLabel);
        }
    }

    const IS_NOTION_RUNTIME = /(^|\.)notion\.(?:site|so)$/i.test(location.hostname);

    if (IS_NOTION_RUNTIME) {
        runNotionRenderedCrawlerHelper().catch(error => {
            try {
                const job = GM_getValue(NOTION_BROWSER_JOB_KEY, null);
                if (job && job.status === 'running') {
                    GM_setValue(NOTION_BROWSER_JOB_KEY, {
                        ...job,
                        status: 'error',
                        error: error?.message || String(error),
                        updatedAt: Date.now()
                    });
                }
            } catch (_) {}
        });
        return;
    }

    GM_addStyle(`
        /*
         * 상단 버튼의 껍데기는 현재 NovelAI menu 버튼의 className을 그대로 복제한다.
         * 여기서는 아이콘/상태 애니메이션만 담당해서 PC·모바일 반응형 디자인을 따라간다.
         */
        #${BUTTON_ID} {
            cursor: pointer;
            flex: 0 0 auto;
        }

        #${BUTTON_ID}.nai-nav-legacy {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            align-self: stretch;
            box-sizing: border-box;
            min-height: 34px;
            min-width: 42px;
            padding: 0 10px;
            border: 0;
            background: transparent;
        }

        #${BUTTON_ID} .nai-nav-diamond {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            font-size: 18px;
            line-height: 16px;
            color: var(--nai-nav-diamond-color, currentColor);
            transform-origin: 50% 50%;
            will-change: transform, opacity, filter;
        }

        #${BUTTON_ID}.nai-analyzing .nai-nav-diamond {
            animation: nai-diamond-work 1.45s ease-in-out infinite;
        }

        #${BUTTON_ID}.nai-analysis-complete .nai-nav-diamond {
            animation: nai-diamond-complete 3.2s ease-in-out infinite;
        }

        @keyframes nai-diamond-work {
            0% { transform: rotate(0deg); }
            48% { transform: rotate(360deg); }
            100% { transform: rotate(360deg); }
        }

        @keyframes nai-diamond-complete {
            0%, 100% { opacity: 1; filter: brightness(1); }
            50% { opacity: 0.22; filter: brightness(1.55); }
        }

        .nai-loader-overlay {
            position: fixed;
            inset: 0;
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.68);
        }

        .nai-loader-modal {
            width: min(780px, calc(100vw - 28px));
            height: calc(100vh - 36px);
            max-height: calc(100vh - 36px);
            overflow: hidden;
            box-sizing: border-box;
            background: #202234;
            color: #fff;
            border: 1px solid #353850;
            border-radius: 8px;
            box-shadow: 0 20px 70px rgba(0, 0, 0, 0.55);
            font-family: inherit;
            display: flex;
            flex-direction: column;
        }

        .nai-loader-header {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 28px;
            padding: 7px 14px 0;
        }

        .nai-loader-title {
            display: inline-flex;
            align-items: baseline;
            gap: 7px;
            min-width: 0;
            font-size: 15px;
            font-weight: 700;
            line-height: 1.1;
        }

        .nai-loader-version {
            color: #858aa6;
            font-size: 10px;
            font-weight: 500;
            letter-spacing: 0.01em;
            white-space: nowrap;
        }

        .nai-loader-close {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            width: 26px;
            height: 26px;
            border: 0;
            background: transparent;
            color: #aaaec7;
            cursor: pointer;
            font-size: 20px;
            line-height: 1;
            padding: 0;
        }

        .nai-loader-tabs {
            flex: 0 0 auto;
            display: flex;
            gap: 4px;
            padding: 7px 14px 0;
            border-bottom: 1px solid #353850;
            overflow-x: auto;
            overflow-y: hidden;
            scrollbar-width: thin;
        }

        .nai-loader-tab {
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            border: 0;
            border-bottom: 2px solid transparent;
            background: transparent;
            color: #9ea3bf;
            padding: 10px 13px;
            cursor: pointer;
            font: inherit;
            font-size: 13px;
            font-weight: 700;
        }

        .nai-loader-tab:hover {
            color: #fff;
        }

        .nai-loader-tab.active {
            color: #fff;
            border-bottom-color: #9773ff;
        }

        .nai-loader-content {
            flex: 1 1 auto;
            overflow-y: auto;
            min-height: 300px;
        }

        .nai-loader-panel {
            display: none;
            padding: 18px;
        }

        .nai-loader-panel.active {
            display: block;
        }

        .nai-loader-label {
            display: block;
            margin: 0 0 7px;
            color: #c8cbe0;
            font-size: 13px;
            font-weight: 600;
        }

        .nai-loader-field {
            margin-bottom: 16px;
        }

        .nai-loader-input,
        .nai-loader-textarea,
        .nai-loader-select {
            display: block;
            width: 100%;
            box-sizing: border-box;
            padding: 10px 12px;
            border: 1px solid #3d405c;
            border-radius: 5px;
            background: #181a2a;
            color: #fff;
            font: inherit;
            outline: none;
        }

        #${MODAL_ID} .nai-loader-input,
        #${MODAL_ID} .nai-loader-textarea,
        #${MODAL_ID} .nai-loader-select {
            color: #ffffff !important;
            -webkit-text-fill-color: #ffffff !important;
            caret-color: #ffffff;
        }

        #${MODAL_ID} .nai-loader-input::placeholder,
        #${MODAL_ID} .nai-loader-textarea::placeholder {
            color: #777b92 !important;
            -webkit-text-fill-color: #777b92 !important;
            opacity: 1 !important;
        }

        .nai-loader-textarea {
            min-height: 115px;
            resize: vertical;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 12px;
            line-height: 1.55;
        }

        .nai-loader-input:focus,
        .nai-loader-textarea:focus,
        .nai-loader-select:focus {
            border-color: #9773ff;
        }

        .nai-loader-row {
            display: flex;
            gap: 10px;
            align-items: center;
        }

        .nai-loader-grow {
            flex: 1 1 auto;
            min-width: 0;
        }

        .nai-import-action-row {
            justify-content: space-between;
        }

        .nai-import-action-row .nai-loader-action {
            flex: 0 0 auto;
            height: 28px;
            min-height: 28px;
            padding: 0 12px;
        }

        .nai-settings-action-row {
            justify-content: flex-end;
        }

        .nai-analysis-header-row {
            flex-wrap: nowrap;
        }

        .nai-loader-action {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            padding: 9px 13px;
            border: 1px solid #454966;
            border-radius: 5px;
            background: #353850;
            color: #fff;
            cursor: pointer;
            font: inherit;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            text-align: center;
            white-space: nowrap;
            vertical-align: middle;
        }

        .nai-loader-action:hover {
            filter: brightness(1.08);
        }

        .nai-loader-action:disabled {
            cursor: wait;
            opacity: 0.6;
            filter: none;
        }

        .nai-loader-action.primary {
            border-color: #9773ff;
            background: #9773ff;
        }

        .nai-loader-action.danger {
            border-color: #7e4250;
            background: #572d39;
        }

        .nai-loader-action.ghost {
            background: transparent;
        }

        .nai-loader-status {
            min-height: 18px;
            margin-top: 10px;
            color: #aeb2cc;
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
        }

        /* 라이브러리/자료실/메모의 일회성 안내는 리스트 아래에 쌓지 않고 토스트로 표시한다. */
        #nai-manual-status,
        #nai-library-status,
        #nai-resource-status,
        #nai-memo-status {
            display: none !important;
            min-height: 0;
            margin: 0;
        }

        .nai-loader-toast {
            position: fixed;
            left: 50%;
            bottom: max(18px, env(safe-area-inset-bottom));
            z-index: 1000002;
            width: max-content;
            max-width: min(620px, calc(100vw - 28px));
            box-sizing: border-box;
            padding: 7px 12px;
            border: 1px solid #4a4f70;
            border-radius: 6px;
            background: rgba(28, 30, 49, 0.96);
            color: #f4f5ff;
            box-shadow: 0 8px 26px rgba(0, 0, 0, 0.38);
            font-size: 12px;
            font-weight: 650;
            line-height: 1.35;
            text-align: center;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            pointer-events: none;
            opacity: 0;
            transform: translate(-50%, 8px);
            transition: opacity 150ms ease, transform 150ms ease;
        }

        .nai-loader-toast.show {
            opacity: 1;
            transform: translate(-50%, 0);
        }

        .nai-loader-toast.error {
            border-color: #8a4a59;
            background: rgba(72, 37, 47, 0.97);
        }

        .nai-library-toolbar {
            display: flex;
            flex-direction: row;
            align-items: stretch;
            gap: 8px;
            margin-bottom: 14px;
        }

        .nai-toolbar-add-button {
            flex: 0 0 40px;
            width: 40px;
            min-width: 40px;
            min-height: 40px;
            padding: 0;
            border-radius: 5px;
            font-size: 20px;
            font-weight: 500;
            line-height: 1;
        }

        .nai-library-category-bar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            margin: -6px 0 14px;
            min-height: 24px;
            width: 100%;
        }

        .nai-library-category-filter-group {
            display: flex;
            flex: 1 1 0;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }

        .nai-library-category-tools {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: auto;
            flex: 0 0 auto;
        }

        /* 상단 필터는 활성화된 분류만 또렷하게 보이게 한다. */
        .nai-library-category-filter-group .nai-library-category-chip:not(.active) {
            opacity: 0.46;
            color: #858aa4;
            background: #202235;
        }

        .nai-library-category-filter-group .nai-library-category-chip:not(.active):hover {
            opacity: 0.8;
            color: #d9dcef;
        }

        .nai-library-category-edit-button {
            min-width: 38px;
        }

        .nai-library-category-edit-button.active {
            border-color: #9773ff;
            background: #5b46a8;
            color: #fff;
        }

        .nai-library-category-manager {
            flex: 1 0 100%;
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 6px;
            padding: 8px;
            border: 1px solid #353954;
            border-radius: 5px;
            background: #1b1e31;
        }

        .nai-library-category-manager-row {
            display: flex;
            align-items: center;
            gap: 6px;
            width: 100%;
        }

        .nai-library-category-manager-row .nai-loader-input {
            height: 28px;
            min-height: 28px;
            padding: 4px 8px;
            font-size: 11px;
        }

        .nai-library-category-manager-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            flex: 0 0 auto;
            min-width: 28px;
            height: 28px;
            padding: 0 7px;
            border: 1px solid #454966;
            border-radius: 4px;
            background: #25283b;
            color: #c5c9db;
            cursor: pointer;
            font: inherit;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
        }

        .nai-library-category-manager-button:hover:not(:disabled) {
            border-color: #656b91;
            background: #30344b;
            color: #fff;
        }

        .nai-library-category-manager-button:disabled {
            opacity: 0.28;
            cursor: default;
        }

        .nai-library-category-manager-button.danger {
            color: #ffadb8;
            border-color: #6c3e4a;
        }

        .nai-library-category-chip {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 23px;
            padding: 0 9px;
            border: 1px solid #454966;
            border-radius: 4px;
            background: #25283b;
            color: #b6bad0;
            cursor: pointer;
            font: inherit;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            white-space: nowrap;
        }

        .nai-library-category-chip:hover {
            border-color: #656b91;
            background: #30344b;
            color: #fff;
        }

        .nai-library-category-chip.active {
            border-color: #9773ff;
            background: #5b46a8;
            color: #fff;
        }

        .nai-library-category-chip.nai-category-add {
            min-width: 25px;
            width: 25px;
            padding: 0;
            font-size: 15px;
        }

        .nai-library-card-category-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            min-height: 0;
            margin-top: 9px;
        }

        /* 보기 모드 분류는 헤더 안이 아니라 헤더와 Base Prompt 사이의 독립 행. */
        .nai-library-card-body > .nai-library-card-category-row {
            margin-top: 3px;
            margin-bottom: 12px;
        }

        .nai-library-card-category-row:empty {
            display: none;
        }

        .nai-library-card-category-row .nai-library-category-chip {
            min-height: 20px;
            padding: 0 7px;
            font-size: 10px;
        }

        /* 카드/수정 화면에서는 미선택 분류를 흐리게, 선택 분류만 또렷하게. */
        .nai-library-card-category-row .nai-library-category-chip:not(.active) {
            opacity: 0.42;
            color: #858aa4;
            background: #202235;
        }

        .nai-library-card-category-row .nai-library-category-chip:not(.active):hover {
            opacity: 0.78;
            color: #d9dcef;
        }

        .nai-library-card-category-row .nai-library-category-chip.active {
            opacity: 1;
        }

        /* 접힌 카드는 한 줄 유지: 분류는 펼쳤을 때만 제목 아래 표시. */
        .nai-concept-card.nai-library-card-collapsed .nai-library-card-category-row {
            display: none !important;
        }

        .nai-library-edit-category-field {
            margin-top: 10px;
        }

        .nai-library-category-empty {
            color: #8f95b2;
            font-size: 11px;
        }

        .nai-inline-create-wrap {
            margin-bottom: 14px;
        }

        .nai-inline-create-wrap[hidden] {
            display: none !important;
        }

        .nai-library-list {
            display: grid;
            gap: 10px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        .nai-library-empty {
            padding: 34px 18px;
            border: 1px dashed #454966;
            border-radius: 7px;
            color: #9ea3bf;
            text-align: center;
            line-height: 1.7;
        }

        .nai-concept-card {
            border: 1px solid #353850;
            border-radius: 7px;
            background: #191b2b;
            /* 접힘/펼침에 관계없이 헤더 위치가 절대 움직이지 않도록 동일 패딩 사용. */
            padding: 8px 13px 8px 8px;
            min-height: 0 !important;
            height: auto !important;
            align-self: start;
        }

        /* 접힘/펼침은 아래 본문만 바뀌고 헤더는 완전히 같은 크기/위치를 유지. */
        .nai-concept-card.nai-library-card-collapsed {
            padding: 8px 13px 8px 8px;
        }

        .nai-concept-card-header {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 8px;
        }

        .nai-library-card-summary {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            min-height: 20px;
            cursor: pointer;
        }

        .nai-library-card-summary-main {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            justify-content: center;
            flex: 1 1 auto;
            min-width: 0;
        }

        .nai-library-card-toggle {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            width: 100%;
            min-width: 0;
            color: inherit;
            font: inherit;
            text-align: left;
        }

        .nai-library-card-toggle .nai-concept-name {
            flex: 0 1 auto;
            min-width: 42px;
            max-width: none;
            overflow: hidden;
            text-overflow: clip;
            white-space: nowrap;
            font-size: 13px;
            line-height: 1.15;
        }

        .nai-library-title-marquee-text {
            display: inline-block;
            white-space: nowrap;
            transform: translateX(0);
            will-change: transform;
        }

        .nai-library-card-toggle .nai-concept-name.nai-title-overflowing .nai-library-title-marquee-text {
            animation: nai-library-title-marquee 6.4s ease-in-out infinite;
        }

        @keyframes nai-library-title-marquee {
            0%, 16% {
                transform: translateX(0);
            }
            66%, 84% {
                transform: translateX(var(--nai-library-title-shift, 0px));
            }
            100% {
                transform: translateX(0);
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .nai-library-card-toggle .nai-concept-name.nai-title-overflowing .nai-library-title-marquee-text {
                animation: none;
            }
        }

        .nai-card-note-preview {
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-align: left;
            color: #9ba0bd;
            font-size: 11px;
            font-weight: 500;
        }

        .nai-card-note-preview[hidden],
        .nai-card-note-separator[hidden] {
            display: none !important;
        }

        .nai-card-note-separator {
            flex: 0 0 auto;
            color: #8f95b2;
            font-size: 11px;
            line-height: 1;
        }

        .nai-library-summary-actions {
            margin-left: auto;
            display: flex;
            flex: 0 0 auto;
            align-items: center;
            justify-content: flex-end;
            gap: 7px;
        }

        .nai-library-summary-actions .nai-loader-action {
            /* 접힘/펼침에서 버튼 크기와 위치가 바뀌지 않도록 하나의 규격만 사용. */
            height: 20px;
            min-height: 20px;
            padding: 0 8px;
            border-radius: 4px;
            font-size: 10px;
            line-height: 1;
        }

        .nai-library-note-body {
            padding-top: 8px;
        }

        .nai-library-note-body[hidden],
        .nai-library-card-body[hidden] {
            display: none !important;
        }

        .nai-library-note-body .nai-note-editor {
            min-height: 72px;
            max-height: 220px;
        }

        .nai-library-card-body {
            padding-top: 8px;
        }

        .nai-concept-name {
            flex: 1 1 auto;
            min-width: 0;
            font-weight: 800;
            font-size: 14px;
            word-break: break-word;
        }

        .nai-concept-footer {
            display: block;
            margin-top: 10px;
        }

        .nai-concept-footer .nai-concept-actions {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-top: 0;
        }

        .nai-concept-action-right {
            margin-left: auto;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: flex-end;
            gap: 7px;
        }


        /* 라이브러리 보기 모드의 사용/복사/수정/원본/삭제 버튼만 슬림하게. */
        .nai-concept-footer .nai-concept-actions .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 9px;
            border-radius: 4px;
            font-size: 11px;
            line-height: 1;
        }

        .nai-concept-footer .nai-loader-action.nai-library-note-active {
            border-color: #9773ff;
            background: #5b46a8;
            color: #fff;
        }

        .nai-edit-footer-actions {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-top: 12px;
        }

        .nai-edit-footer-actions .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 9px;
            border-radius: 4px;
            font-size: 11px;
            line-height: 1;
        }

        .nai-concept-tags {
            display: block !important;
            padding: 8px 10px;
            margin: 0;
            border-radius: 5px;
            background: #131522;
            color: #d8dbeb;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 12px;
            line-height: 1.55;
            white-space: pre-wrap;
            word-break: break-word;
            text-align: left !important;
            min-height: 0 !important;
            height: auto !important;
            max-height: 150px;
            overflow: auto;
        }

        .nai-concept-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            margin-top: 10px;
        }

        .nai-loader-section-title {
            margin: 0 0 9px;
            font-size: 14px;
            font-weight: 800;
        }

        .nai-loader-muted {
            color: #959ab7;
            font-size: 12px;
            line-height: 1.55;
        }

        .nai-duplicate-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 20px;
            box-sizing: border-box;
            padding: 0 7px;
            border: 1px solid rgba(255, 170, 98, 0.6);
            border-radius: 999px;
            background: rgba(255, 142, 61, 0.14);
            color: #ffc18e;
            font-size: 10px;
            font-weight: 800;
            line-height: 1;
            white-space: nowrap;
        }

        .nai-duplicate-badge[hidden] {
            display: none !important;
        }

        .nai-duplicate-warning {
            margin: 0 0 10px;
            padding: 7px 9px;
            border: 1px solid rgba(255, 170, 98, 0.45);
            border-radius: 5px;
            background: rgba(255, 142, 61, 0.1);
            color: #ffc18e;
            font-size: 11px;
            line-height: 1.45;
        }

        .nai-duplicate-warning[hidden] {
            display: none !important;
        }

        .nai-loader-divider {
            height: 1px;
            margin: 18px 0;
            background: #353850;
        }

        .nai-import-result {
            border: 1px solid #3d405c;
            border-radius: 7px;
            padding: 14px;
            background: #191b2b;
        }

        .nai-share-import-preview {
            margin-top: 12px;
        }

        .nai-share-import-preview[hidden] {
            display: none !important;
        }

        .nai-share-import-preview .nai-import-result {
            padding: 12px;
        }

        .nai-share-import-preview .nai-loader-section-title {
            margin-bottom: 12px;
        }

        .nai-share-import-preview .nai-library-card-category-row {
            margin-top: 0;
        }

        .nai-backup-box {
            padding: 12px;
            border: 1px solid #353954;
            border-radius: 7px;
            background: #191b2b;
        }

        .nai-backup-choice-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 7px;
            margin-top: 10px;
        }

        .nai-backup-choice {
            min-width: 72px;
        }

        .nai-backup-choice:not(.active) {
            opacity: 0.48;
            color: #8c90a8;
            background: #202235;
        }

        .nai-backup-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 12px;
        }

        .nai-backup-section-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-top: 12px;
        }

        .nai-backup-section {
            border: 1px solid #353954;
            border-radius: 6px;
            background: #171927;
            overflow: hidden;
        }

        .nai-backup-section-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 9px;
            border-bottom: 1px solid #30344d;
        }

        .nai-backup-section-title {
            color: #eef0f8;
            font-size: 12px;
            font-weight: 800;
        }

        .nai-backup-section-count {
            color: #8f94ae;
            font-size: 11px;
            font-weight: 700;
        }

        .nai-backup-section-controls {
            display: flex;
            gap: 6px;
            margin-left: auto;
        }

        .nai-backup-section-controls .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 8px;
            font-size: 10px;
        }

        .nai-backup-item-list {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 5px;
            max-height: 180px;
            overflow-y: auto;
            padding: 8px;
        }

        .nai-backup-item {
            display: flex;
            align-items: center;
            gap: 7px;
            min-width: 0;
            padding: 6px 8px;
            border: 1px solid #333750;
            border-radius: 5px;
            background: #1c1f31;
            color: #cfd2e2;
            cursor: pointer;
            font-size: 11px;
            line-height: 1.3;
        }

        .nai-backup-item:hover {
            border-color: #505574;
            background: #22263a;
        }

        .nai-backup-item input {
            flex: 0 0 auto;
            width: 14px;
            height: 14px;
            margin: 0;
            accent-color: #9773ff;
        }

        .nai-backup-item-label {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .nai-backup-empty {
            grid-column: 1 / -1;
            padding: 7px 4px;
            color: #777d99;
            font-size: 11px;
        }

        .nai-restore-preview {
            margin-top: 12px;
            padding: 12px;
            border: 1px solid #454966;
            border-radius: 7px;
            background: #181a2a;
        }

        .nai-restore-preview[hidden] {
            display: none !important;
        }

        .nai-restore-file-name {
            margin-bottom: 8px;
            color: #e1e4f2;
            font-size: 12px;
            font-weight: 700;
            overflow-wrap: anywhere;
        }

        .nai-restore-summary {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 10px;
            color: #b7bbcf;
            font-size: 12px;
            line-height: 1.45;
        }

        .nai-restore-summary strong {
            color: #f1f2f7;
        }

        .nai-provider-buttons {
            display: flex;
            gap: 8px;
            margin-bottom: 18px;
        }

        .nai-provider-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            flex: 1 1 0;
            padding: 10px;
            border: 1px solid #3d405c;
            border-radius: 5px;
            background: #181a2a;
            color: #fff;
            cursor: pointer;
            font: inherit;
            font-size: 12px;
            font-weight: 700;
        }

        .nai-provider-button.active {
            border-color: #9773ff;
            background: rgba(151, 115, 255, 0.16);
        }

        .nai-provider-section {
            display: none;
        }

        .nai-provider-section.active {
            display: block;
        }

        .nai-ai-results {
            display: grid;
            gap: 10px;
            margin-top: 12px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        .nai-ai-result-card {
            border: 1px solid #454966;
            border-radius: 7px;
            padding: 13px;
            background: #171927;
            min-height: 0;
            height: auto;
            align-self: start;
        }

        .nai-ai-result-card .nai-loader-textarea {
            min-height: 72px;
            max-height: 260px;
            overflow-y: auto;
        }

        .nai-ai-result-head {
            display: flex;
            gap: 9px;
            align-items: center;
            margin-bottom: 10px;
        }

        .nai-ai-result-head input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: #9773ff;
            flex: 0 0 auto;
        }

        .nai-ai-result-index {
            font-size: 12px;
            font-weight: 800;
            color: #aeb2cc;
        }

        .nai-ai-extra-options {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            margin-left: auto;
        }

        .nai-ai-add-character {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            height: 24px;
            min-height: 24px;
            padding: 0 8px;
            border: 1px solid #454966;
            border-radius: 4px;
            background: #1b1e30;
            color: #d2d5e8;
            font-size: 11px;
            font-weight: 800;
            line-height: 1;
            text-align: center;
            cursor: pointer;
        }

        .nai-ai-add-character:hover:not(:disabled) {
            background: #292d45;
            border-color: #626786;
        }

        .nai-ai-add-character:disabled {
            opacity: 0.4;
            cursor: default;
        }

        .nai-analysis-prompt-editor {
            margin-bottom: 12px;
        }

        .nai-analysis-prompt-tabs {
            display: flex;
            align-items: flex-end;
            gap: 14px;
            min-height: 29px;
            margin-bottom: 8px;
            border-bottom: 1px solid #353850;
        }

        .nai-analysis-prompt-tab {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 29px;
            padding: 0 1px 6px;
            border: 0;
            border-bottom: 2px solid transparent;
            background: transparent;
            color: #8f95b5;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            text-align: center;
            cursor: pointer;
        }

        .nai-analysis-prompt-tab.active {
            color: #f1f2fa;
            border-bottom-color: #8ca5ff;
        }

        .nai-analysis-prompt-panel[hidden] {
            display: none !important;
        }

        .nai-ai-character-title-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 4px;
        }

        .nai-ai-character-remove {
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            width: 24px;
            height: 24px;
            padding: 0;
            border: 0;
            border-radius: 4px;
            background: transparent;
            color: #969cb8;
            font-size: 18px;
            line-height: 1;
            text-align: center;
            cursor: pointer;
        }

        .nai-ai-character-remove:hover {
            background: rgba(255, 255, 255, 0.07);
            color: #f0f1f8;
        }

        .nai-inline-note-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 24px;
            padding: 0 2px;
            border: 0;
            background: transparent;
            color: #b8bbcf;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            cursor: pointer;
            white-space: nowrap;
        }

        .nai-inline-note-toggle:hover {
            color: #fff;
        }

        .nai-inline-note-body {
            width: 100%;
            margin: 0 0 10px;
        }

        .nai-inline-note-body[hidden] {
            display: none !important;
        }

        .nai-note-details {
            margin: 0 0 10px;
            border: 0;
            background: transparent;
        }

        .nai-note-details > summary {
            min-height: 22px;
            padding: 0;
            cursor: pointer;
            color: #b8bbcf;
            font-size: 12px;
            font-weight: 700;
            line-height: 22px;
            user-select: none;
        }

        .nai-note-details > summary::marker {
            color: #959ab7;
        }

        .nai-note-editor {
            width: 100%;
            margin: 0;
            box-sizing: border-box;
        }

        .nai-character-group {
            display: grid;
            gap: 9px;
            margin-top: 10px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        .nai-character-block {
            padding: 10px;
            border: 1px solid #363a55;
            border-radius: 6px;
            background: #131522;
            min-height: 0 !important;
            height: auto !important;
            align-self: start;
        }

        .nai-character-title {
            margin-bottom: 7px;
            color: #c8cbe0;
            font-size: 12px;
            font-weight: 800;
        }

        .nai-character-subtitle {
            margin: 8px 0 5px;
            color: #959ab7;
            font-size: 11px;
            font-weight: 700;
        }

        .nai-character-block .nai-concept-tags {
            max-height: 130px;
        }

        .nai-ai-character-block {
            margin: 0 0 10px;
            padding: 10px;
            border: 1px solid #363a55;
            border-radius: 6px;
            background: #131522;
        }

        .nai-ai-character-block:last-child {
            margin-bottom: 0;
        }

        .nai-loading {
            display: inline-flex;
            align-items: center;
            gap: 7px;
        }

        .nai-loading::before {
            content: '';
            width: 10px;
            height: 10px;
            border: 2px solid #6e7393;
            border-top-color: #fff;
            border-radius: 50%;
            animation: nai-spin 0.8s linear infinite;
        }

        @keyframes nai-spin {
            to { transform: rotate(360deg); }
        }

        .nai-info-create-card {
            margin-bottom: 14px;
            border: 1px solid #3d405c;
            border-radius: 7px;
            padding: 13px;
            background: #191b2b;
        }

        .nai-info-create-card .nai-loader-textarea,
        .nai-info-edit-card .nai-loader-textarea {
            min-height: 78px;
            max-height: 240px;
        }

        .nai-info-list {
            display: grid;
            gap: 10px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        /* 자료실은 링크 카드를 3열로 배치한다. */
        #nai-resource-list {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .nai-info-card {
            border: 1px solid #353850;
            border-radius: 7px;
            background: #191b2b;
            padding: 13px;
        }

        #nai-resource-list .nai-resource-card {
            display: flex;
            padding: 10px 13px 10px 8px;
            flex-direction: column;
            min-width: 0;
            min-height: 120px;
            cursor: pointer;
            transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
        }

        #nai-resource-list .nai-resource-card:hover,
        #nai-resource-list .nai-resource-card:focus-visible {
            border-color: #555b83;
            background: #1d2032;
            outline: none;
        }

        #nai-resource-list .nai-resource-card:active {
            transform: translateY(1px);
        }

        #nai-resource-list .nai-resource-card .nai-info-card-head {
            margin-bottom: 0;
        }

        .nai-resource-title-group {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            max-width: 100%;
        }

        .nai-resource-title-group .nai-info-card-title {
            flex: 0 1 auto;
        }

        .nai-resource-order-handle,
        .nai-library-order-handle,
        .nai-memo-order-handle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            flex: 0 0 auto;
            width: 22px;
            height: 22px;
            padding: 0;
            border: 0;
            border-radius: 4px;
            background: transparent;
            color: #8f95af;
            cursor: grab;
            touch-action: none;
            user-select: none;
            font: inherit;
            font-size: 15px;
            font-weight: 800;
            line-height: 1;
        }

        .nai-resource-order-handle:hover,
        .nai-library-order-handle:hover,
        .nai-memo-order-handle:hover {
            background: #30344b;
            color: #fff;
        }

        .nai-resource-order-handle:active,
        .nai-resource-order-handle.dragging,
        .nai-library-order-handle:active,
        .nai-library-order-handle.dragging,
        .nai-memo-order-handle:active,
        .nai-memo-order-handle.dragging {
            cursor: grabbing;
            background: #5b46a8;
            color: #fff;
        }

        #nai-resource-list .nai-resource-card.nai-resource-dragging {
            opacity: 0.58;
            border-color: #9773ff;
            background: #24263d;
            transform: scale(0.985);
            cursor: grabbing;
            z-index: 2;
        }

        #nai-resource-list.nai-resource-drag-active .nai-resource-card:not(.nai-resource-dragging) {
            transition: transform 0.1s ease, border-color 0.1s ease, background 0.1s ease;
        }

        #nai-library-list .nai-concept-card.nai-library-dragging {
            opacity: 0.58;
            border-color: #9773ff;
            background: #24263d;
            transform: scale(0.995);
            cursor: grabbing;
            z-index: 2;
        }

        #nai-library-list.nai-library-drag-active .nai-concept-card:not(.nai-library-dragging) {
            transition: transform 0.1s ease, border-color 0.1s ease, background 0.1s ease;
        }

        /* 메모는 본문을 항상 보여주되 자료실처럼 촘촘한 드래그 카드로 정리한다. */
        #nai-memo-list .nai-memo-card {
            display: flex;
            flex-direction: column;
            min-width: 0;
            padding: 10px 13px 10px 8px;
        }

        #nai-memo-list .nai-memo-card .nai-info-card-head {
            margin-bottom: 0;
        }

        .nai-memo-title-group {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            max-width: 100%;
        }

        .nai-memo-title-group .nai-info-card-title {
            flex: 0 1 auto;
        }

        #nai-memo-list .nai-memo-card.nai-memo-dragging {
            opacity: 0.58;
            border-color: #9773ff;
            background: #24263d;
            transform: scale(0.995);
            cursor: grabbing;
            z-index: 2;
        }

        #nai-memo-list.nai-memo-drag-active .nai-memo-card:not(.nai-memo-dragging) {
            transition: transform 0.1s ease, border-color 0.1s ease, background 0.1s ease;
        }

        .nai-memo-category-badges {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            margin-top: 8px;
            pointer-events: none;
        }

        .nai-memo-category-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 20px;
            padding: 0 7px;
            border: 1px solid #9773ff;
            border-radius: 4px;
            background: #5b46a8;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            line-height: 1;
            white-space: nowrap;
        }

        #nai-memo-list .nai-memo-card .nai-info-note {
            margin-top: 9px;
        }

        #nai-memo-list .nai-memo-card .nai-info-actions {
            margin-top: 10px;
        }

        /* 보기 카드에서는 선택된 분류만 표시하며 직접 수정하지 않는다. */
        .nai-resource-category-badges {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            margin-top: 8px;
            pointer-events: none;
        }

        .nai-resource-category-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 20px;
            padding: 0 7px;
            border: 1px solid #9773ff;
            border-radius: 4px;
            background: #5b46a8;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            line-height: 1;
            white-space: nowrap;
        }

        #nai-resource-list .nai-resource-card .nai-info-note {
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 4;
            overflow: hidden;
            margin-top: 9px;
        }

        /* 삭제/수정 구간은 링크 카드 클릭 대상에서 분리한다. */
        #nai-resource-list .nai-resource-card .nai-info-actions {
            cursor: default;
        }

        #nai-resource-list .nai-resource-card .nai-info-actions {
            margin-top: auto;
            padding-top: 12px;
        }

        #nai-resource-list .nai-info-edit-card {
            grid-column: 1 / -1;
            cursor: default;
        }

        .nai-info-card-head {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            margin-bottom: 7px;
        }

        .nai-info-card-title {
            min-width: 0;
            flex: 1 1 auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #eef0f8;
            font-size: 13px;
            font-weight: 800;
        }

        .nai-info-note {
            margin-top: 7px;
            color: #c9ccdc;
            font-size: 12px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .nai-info-actions {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 10px;
        }

        .nai-info-action-right {
            margin-left: auto;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            flex-wrap: wrap;
            gap: 7px;
        }

        .nai-info-actions .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 9px;
            border-radius: 4px;
            font-size: 11px;
        }

        @media (max-width: 860px) {
            #nai-resource-list {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }
        }

        @media (max-width: 620px) {
            #nai-resource-list {
                grid-template-columns: minmax(0, 1fr);
            }

            .nai-backup-item-list {
                grid-template-columns: minmax(0, 1fr);
            }

            .nai-loader-row {
                flex-direction: column;
                align-items: stretch;
            }

            .nai-provider-buttons {
                flex-direction: row;
                align-items: stretch;
                gap: 8px;
            }

            .nai-provider-button {
                flex: 1 1 0;
                min-width: 0;
                padding: 10px 6px;
                font-size: 11px;
            }

            .nai-library-toolbar,
            .nai-import-action-row,
            .nai-settings-action-row {
                flex-direction: row;
                align-items: stretch;
            }

            .nai-import-action-row {
                gap: 8px;
            }

            .nai-import-action-row .nai-loader-action {
                flex: 1 1 0;
                min-width: 0;
                height: 28px;
                min-height: 28px;
                padding: 0 7px;
                font-size: 11px;
            }

            .nai-settings-action-row {
                justify-content: flex-end;
                gap: 8px;
            }

            .nai-settings-action-row .nai-loader-action {
                flex: 0 0 auto;
            }

            .nai-analysis-header-row {
                flex-direction: row;
                align-items: stretch;
                flex-wrap: wrap;
                gap: 8px;
            }

            .nai-analysis-header-row .nai-loader-section-title {
                flex: 0 0 100%;
                width: 100%;
            }

            .nai-analysis-header-row .nai-loader-action {
                flex: 1 1 0;
                min-width: 0;
                height: 28px;
                min-height: 28px;
                padding: 0 6px;
                font-size: 11px;
            }
        }
    `);

    function simpleHash(value) {
        let hash = 2166136261;
        const s = String(value || '');
        for (let i = 0; i < s.length; i++) {
            hash ^= s.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function getSettings() {
        const saved = GM_getValue(SETTINGS_KEY, {});
        const merged = { ...DEFAULT_SETTINGS, ...(saved || {}) };

        merged.geminiModel = merged.geminiModel || DEFAULT_MODEL;
        merged.vertexModel = merged.vertexModel || DEFAULT_MODEL;
        merged.firebaseModel = merged.firebaseModel || DEFAULT_MODEL;
        merged.firebaseBackend = merged.firebaseBackend || 'vertex';

        return merged;
    }

    function saveSettings(settings) {
        GM_setValue(SETTINGS_KEY, {
            ...DEFAULT_SETTINGS,
            ...(settings || {})
        });
    }

    function normalizeCharacterRows(rows) {
        if (!Array.isArray(rows)) return [];

        return rows
            .map((row, index) => {
                const prompt = String(
                    row?.prompt ??
                    row?.tags ??
                    row?.positivePrompt ??
                    ''
                ).trim();

                const negativePrompt = String(
                    row?.negativePrompt ??
                    row?.negativeTags ??
                    row?.undesiredContent ??
                    ''
                ).trim();

                const isDraft = !!row?._analysisDraft;
                if (!prompt && !negativePrompt && !isDraft) return null;

                return {
                    name:
                        String(row?.name || row?.label || '').trim() ||
                        `Character ${index + 1}`,
                    prompt,
                    negativePrompt,
                    ...(isDraft ? { _analysisDraft: true } : {})
                };
            })
            .filter(Boolean);
    }

    function normalizeLibraryCategoryName(value) {
        return String(value || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 30);
    }

    function normalizeLibraryCategoryList(values) {
        const seen = new Set();
        return (Array.isArray(values) ? values : [])
            .map(normalizeLibraryCategoryName)
            .filter(name => {
                if (!name || name === '전체' || name === '+' || seen.has(name)) return false;
                seen.add(name);
                return true;
            });
    }

    function getLibraryCategories() {
        const saved = normalizeLibraryCategoryList(
            GM_getValue(LIBRARY_CATEGORY_KEY, [])
        );

        const fromItems = getLibrary()
            .flatMap(item => Array.isArray(item.categories) ? item.categories : []);

        return normalizeLibraryCategoryList([...saved, ...fromItems]);
    }

    function saveLibraryCategories(categories) {
        GM_setValue(
            LIBRARY_CATEGORY_KEY,
            normalizeLibraryCategoryList(categories)
        );
    }

    function normalizeConceptRecord(item) {
        const tags = String(
            item?.tags ??
            item?.basePrompt ??
            item?.prompt ??
            ''
        ).trim();

        const negativeTags = String(
            item?.negativeTags ??
            item?.negativePrompt ??
            item?.undesiredContent ??
            ''
        ).trim();

        const characters = normalizeCharacterRows(item?.characters);
        const {
            includeNegativeTags: _legacyIncludeNegativeTags,
            includeCharacterNegative: _legacyIncludeCharacterNegative,
            ...rest
        } = item || {};

        return {
            ...rest,
            tags,
            negativeTags,
            characters,
            note: String(item?.note || '').trim(),
            categories: normalizeLibraryCategoryList(item?.categories)
        };
    }

    function getLibrary() {
        const saved = GM_getValue(LIBRARY_KEY, []);
        return Array.isArray(saved)
            ? saved.map(normalizeConceptRecord)
            : [];
    }

    function saveLibrary(library) {
        GM_setValue(
            LIBRARY_KEY,
            Array.isArray(library)
                ? library.map(normalizeConceptRecord)
                : []
        );
    }

    function normalizeResourceRecord(item) {
        return {
            id: String(item?.id || createId()),
            name: String(item?.name || '').trim(),
            url: String(item?.url || '').trim(),
            note: String(item?.note || '').trim(),
            categories: normalizeLibraryCategoryList(item?.categories),
            createdAt: Number(item?.createdAt || Date.now()),
            updatedAt: Number(item?.updatedAt || item?.createdAt || Date.now())
        };
    }

    function getResources() {
        const saved = GM_getValue(RESOURCE_KEY, []);
        return Array.isArray(saved)
            ? saved.map(normalizeResourceRecord)
            : [];
    }

    function saveResources(resources) {
        GM_setValue(
            RESOURCE_KEY,
            Array.isArray(resources)
                ? resources.map(normalizeResourceRecord)
                : []
        );
    }

    function getResourceCategories() {
        const saved = normalizeLibraryCategoryList(
            GM_getValue(RESOURCE_CATEGORY_KEY, [])
        );
        const fromItems = getResources()
            .flatMap(item => Array.isArray(item.categories) ? item.categories : []);
        return normalizeLibraryCategoryList([...saved, ...fromItems]);
    }

    function saveResourceCategories(categories) {
        GM_setValue(
            RESOURCE_CATEGORY_KEY,
            normalizeLibraryCategoryList(categories)
        );
    }

    function normalizeMemoRecord(item) {
        return {
            id: String(item?.id || createId()),
            title: String(item?.title || '').trim(),
            content: String(item?.content || '').trim(),
            categories: normalizeLibraryCategoryList(item?.categories),
            createdAt: Number(item?.createdAt || Date.now()),
            updatedAt: Number(item?.updatedAt || item?.createdAt || Date.now())
        };
    }

    function getMemos() {
        const saved = GM_getValue(MEMO_KEY, []);
        return Array.isArray(saved)
            ? saved.map(normalizeMemoRecord)
            : [];
    }

    function saveMemos(memos) {
        GM_setValue(
            MEMO_KEY,
            Array.isArray(memos)
                ? memos.map(normalizeMemoRecord)
                : []
        );
    }

    function exactStoredText(value) {
        return String(value || '').trim();
    }

    function conceptExactContentKey(item) {
        const normalized = normalizeConceptRecord(item);
        const characters = normalizeCharacterRows(normalized.characters)
            .map(character => ({
                prompt: exactStoredText(character.prompt),
                negativePrompt: exactStoredText(character.negativePrompt)
            }))
            .filter(character => character.prompt || character.negativePrompt);

        return JSON.stringify({
            tags: exactStoredText(normalized.tags),
            negativeTags: exactStoredText(normalized.negativeTags),
            characters
        });
    }

    function findLibraryExactDuplicate(item) {
        const key = conceptExactContentKey(item);
        return getLibrary().find(saved => conceptExactContentKey(saved) === key) || null;
    }

    function findResourceExactDuplicate(url) {
        const normalizedUrl = normalizedExternalUrl(url);
        if (!normalizedUrl) return null;
        return getResources().find(item => normalizedExternalUrl(item.url) === normalizedUrl) || null;
    }

    function findMemoExactDuplicate(content) {
        const normalizedContent = exactStoredText(content);
        if (!normalizedContent) return null;
        return getMemos().find(item => exactStoredText(item.content) === normalizedContent) || null;
    }

    function getMemoCategories() {
        const saved = normalizeLibraryCategoryList(
            GM_getValue(MEMO_CATEGORY_KEY, [])
        );
        const fromItems = getMemos()
            .flatMap(item => Array.isArray(item.categories) ? item.categories : []);
        return normalizeLibraryCategoryList([...saved, ...fromItems]);
    }

    function saveMemoCategories(categories) {
        GM_setValue(
            MEMO_CATEGORY_KEY,
            normalizeLibraryCategoryList(categories)
        );
    }

    const ARCHIVE_BACKUP_FORMAT = 'NAI_ARCHIVE_BACKUP';
    const ARCHIVE_BACKUP_VERSION = 1;

    function backupConceptRecord(item) {
        const normalized = normalizeConceptRecord(item);
        const source = normalized?.source && typeof normalized.source === 'object'
            ? normalized.source
            : {};

        return {
            name: String(normalized.name || normalized.suggestedName || '').trim(),
            tags: String(normalized.tags || '').trim(),
            negativeTags: String(normalized.negativeTags || '').trim(),
            characters: normalizeCharacterRows(normalized.characters).map(character => ({
                name: String(character.name || '').trim(),
                prompt: String(character.prompt || '').trim(),
                negativePrompt: String(character.negativePrompt || '').trim()
            })),
            note: String(normalized.note || '').trim(),
            categories: normalizeLibraryCategoryList(normalized.categories),
            source: {
                type: String(source.type || '').trim(),
                url: String(source.url || normalized.sourceUrl || '').trim(),
                rootUrl: String(source.rootUrl || '').trim(),
                provider: String(source.provider || '').trim(),
                importMethod: String(source.importMethod || '').trim(),
                pageTitle: String(source.pageTitle || '').trim()
            },
            createdAt: Number(normalized.createdAt || Date.now()),
            updatedAt: Number(normalized.updatedAt || normalized.createdAt || Date.now())
        };
    }

    function categoriesUsedByBackupItems(items, orderedCategories) {
        const used = new Set(
            (Array.isArray(items) ? items : [])
                .flatMap(item => normalizeLibraryCategoryList(item?.categories))
        );
        const ordered = normalizeLibraryCategoryList(orderedCategories)
            .filter(category => used.has(category));
        const extras = [...used].filter(category => !ordered.includes(category));
        return normalizeLibraryCategoryList([...ordered, ...extras]);
    }

    function createArchiveBackupPayload(selection) {
        const sections = {};
        const selectedIds = selection && !Array.isArray(selection) && typeof selection === 'object'
            ? selection
            : null;
        const legacyKinds = new Set(Array.isArray(selection) ? selection : []);

        const resolveSelected = (kind, items) => {
            if (!selectedIds) {
                return legacyKinds.has(kind) ? items : [];
            }
            const raw = selectedIds[kind];
            const ids = raw instanceof Set
                ? raw
                : new Set(Array.isArray(raw) ? raw.map(String) : []);
            return items.filter(item => ids.has(String(item?.id || '')));
        };

        const libraryItems = resolveSelected('library', getLibrary());
        if (libraryItems.length) {
            sections.library = {
                categories: categoriesUsedByBackupItems(libraryItems, getLibraryCategories()),
                items: libraryItems.map(backupConceptRecord)
            };
        }

        const resourceItems = resolveSelected('resources', getResources());
        if (resourceItems.length) {
            sections.resources = {
                categories: categoriesUsedByBackupItems(resourceItems, getResourceCategories()),
                items: resourceItems.map(item => ({
                    name: String(item.name || '').trim(),
                    url: String(item.url || '').trim(),
                    note: String(item.note || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    createdAt: Number(item.createdAt || Date.now()),
                    updatedAt: Number(item.updatedAt || item.createdAt || Date.now())
                }))
            };
        }

        const memoItems = resolveSelected('memos', getMemos());
        if (memoItems.length) {
            sections.memos = {
                categories: categoriesUsedByBackupItems(memoItems, getMemoCategories()),
                items: memoItems.map(item => ({
                    title: String(item.title || '').trim(),
                    content: String(item.content || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    createdAt: Number(item.createdAt || Date.now()),
                    updatedAt: Number(item.updatedAt || item.createdAt || Date.now())
                }))
            };
        }

        return {
            format: ARCHIVE_BACKUP_FORMAT,
            version: ARCHIVE_BACKUP_VERSION,
            app: APP_NAME,
            appVersion: APP_VERSION,
            exportedAt: new Date().toISOString(),
            sections
        };
    }

    function parseArchiveBackupPayload(rawText) {
        let parsed;
        try {
            parsed = JSON.parse(String(rawText || ''));
        } catch (_) {
            throw new Error('JSON 백업 파일을 읽을 수 없습니다.');
        }

        if (!parsed || parsed.format !== ARCHIVE_BACKUP_FORMAT) {
            throw new Error('NAI Archive 백업 파일이 아닙니다.');
        }

        if (Number(parsed.version) !== ARCHIVE_BACKUP_VERSION) {
            throw new Error(`지원하지 않는 백업 형식 버전입니다: ${parsed.version ?? '알 수 없음'}`);
        }

        const rawSections = parsed.sections && typeof parsed.sections === 'object'
            ? parsed.sections
            : {};
        const sections = {};

        if (rawSections.library && Array.isArray(rawSections.library.items)) {
            sections.library = {
                categories: normalizeLibraryCategoryList(rawSections.library.categories),
                items: rawSections.library.items.map(backupConceptRecord)
            };
        }

        if (rawSections.resources && Array.isArray(rawSections.resources.items)) {
            sections.resources = {
                categories: normalizeLibraryCategoryList(rawSections.resources.categories),
                items: rawSections.resources.items.map(normalizeResourceRecord)
            };
        }

        if (rawSections.memos && Array.isArray(rawSections.memos.items)) {
            sections.memos = {
                categories: normalizeLibraryCategoryList(rawSections.memos.categories),
                items: rawSections.memos.items.map(normalizeMemoRecord)
            };
        }

        if (!Object.keys(sections).length) {
            throw new Error('복원할 라이브러리/자료실/메모 데이터가 없습니다.');
        }

        return {
            format: ARCHIVE_BACKUP_FORMAT,
            version: ARCHIVE_BACKUP_VERSION,
            appVersion: String(parsed.appVersion || ''),
            exportedAt: String(parsed.exportedAt || ''),
            sections
        };
    }

    function inspectArchiveRestore(backup) {
        const result = {};

        if (backup?.sections?.library) {
            const seen = new Set(getLibrary().map(conceptExactContentKey));
            let duplicate = 0;
            let addable = 0;
            for (const item of backup.sections.library.items) {
                const key = conceptExactContentKey(item);
                if (seen.has(key)) duplicate += 1;
                else {
                    seen.add(key);
                    addable += 1;
                }
            }
            result.library = {
                total: backup.sections.library.items.length,
                duplicate,
                addable,
                invalid: 0
            };
        }

        if (backup?.sections?.resources) {
            const seen = new Set(
                getResources()
                    .map(item => normalizedExternalUrl(item.url))
                    .filter(Boolean)
            );
            let duplicate = 0;
            let addable = 0;
            let invalid = 0;
            for (const item of backup.sections.resources.items) {
                const key = normalizedExternalUrl(item.url);
                if (!key) invalid += 1;
                else if (seen.has(key)) duplicate += 1;
                else {
                    seen.add(key);
                    addable += 1;
                }
            }
            result.resources = {
                total: backup.sections.resources.items.length,
                duplicate,
                addable,
                invalid
            };
        }

        if (backup?.sections?.memos) {
            const seen = new Set(
                getMemos()
                    .map(item => exactStoredText(item.content))
                    .filter(Boolean)
            );
            let duplicate = 0;
            let addable = 0;
            let invalid = 0;
            for (const item of backup.sections.memos.items) {
                const key = exactStoredText(item.content);
                if (!key) invalid += 1;
                else if (seen.has(key)) duplicate += 1;
                else {
                    seen.add(key);
                    addable += 1;
                }
            }
            result.memos = {
                total: backup.sections.memos.items.length,
                duplicate,
                addable,
                invalid
            };
        }

        return result;
    }

    function restoreArchiveBackup(backup, kinds) {
        const selected = new Set(Array.isArray(kinds) ? kinds : []);
        const result = {
            library: { added: 0, duplicate: 0, invalid: 0 },
            resources: { added: 0, duplicate: 0, invalid: 0 },
            memos: { added: 0, duplicate: 0, invalid: 0 }
        };
        const now = Date.now();

        if (selected.has('library') && backup?.sections?.library) {
            const current = getLibrary();
            const seen = new Set(current.map(conceptExactContentKey));
            const added = [];

            for (const rawItem of backup.sections.library.items) {
                const item = backupConceptRecord(rawItem);
                const key = conceptExactContentKey(item);
                if (seen.has(key)) {
                    result.library.duplicate += 1;
                    continue;
                }
                seen.add(key);
                const source = item.source && typeof item.source === 'object' ? item.source : {};
                added.push({
                    id: createId(),
                    name: String(item.name || '').trim() || '복원한 컨셉',
                    tags: String(item.tags || '').trim(),
                    negativeTags: String(item.negativeTags || '').trim(),
                    characters: normalizeCharacterRows(item.characters),
                    note: String(item.note || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    source: {
                        type: String(source.type || '').trim(),
                        url: String(source.url || '').trim(),
                        rootUrl: String(source.rootUrl || '').trim(),
                        provider: String(source.provider || '').trim(),
                        importMethod: String(source.importMethod || '').trim(),
                        pageTitle: String(source.pageTitle || '').trim()
                    },
                    createdAt: Number(item.createdAt || now),
                    updatedAt: now
                });
            }

            if (added.length) saveLibrary([...current, ...added]);
            saveLibraryCategories(normalizeLibraryCategoryList([
                ...getLibraryCategories(),
                ...backup.sections.library.categories,
                ...added.flatMap(item => item.categories)
            ]));
            result.library.added = added.length;
        }

        if (selected.has('resources') && backup?.sections?.resources) {
            const current = getResources();
            const seen = new Set(current.map(item => normalizedExternalUrl(item.url)).filter(Boolean));
            const added = [];

            for (const rawItem of backup.sections.resources.items) {
                const item = normalizeResourceRecord(rawItem);
                const key = normalizedExternalUrl(item.url);
                if (!key) {
                    result.resources.invalid += 1;
                    continue;
                }
                if (seen.has(key)) {
                    result.resources.duplicate += 1;
                    continue;
                }
                seen.add(key);
                added.push({
                    ...item,
                    id: createId(),
                    url: key,
                    createdAt: Number(item.createdAt || now),
                    updatedAt: now
                });
            }

            if (added.length) saveResources([...current, ...added]);
            saveResourceCategories(normalizeLibraryCategoryList([
                ...getResourceCategories(),
                ...backup.sections.resources.categories,
                ...added.flatMap(item => item.categories)
            ]));
            result.resources.added = added.length;
        }

        if (selected.has('memos') && backup?.sections?.memos) {
            const current = getMemos();
            const seen = new Set(current.map(item => exactStoredText(item.content)).filter(Boolean));
            const added = [];

            for (const rawItem of backup.sections.memos.items) {
                const item = normalizeMemoRecord(rawItem);
                const key = exactStoredText(item.content);
                if (!key) {
                    result.memos.invalid += 1;
                    continue;
                }
                if (seen.has(key)) {
                    result.memos.duplicate += 1;
                    continue;
                }
                seen.add(key);
                added.push({
                    ...item,
                    id: createId(),
                    content: key,
                    createdAt: Number(item.createdAt || now),
                    updatedAt: now
                });
            }

            if (added.length) saveMemos([...current, ...added]);
            saveMemoCategories(normalizeLibraryCategoryList([
                ...getMemoCategories(),
                ...backup.sections.memos.categories,
                ...added.flatMap(item => item.categories)
            ]));
            result.memos.added = added.length;
        }

        return result;
    }

    function normalizedExternalUrl(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(raw);
            if (!/^https?:$/i.test(url.protocol)) return '';
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function fallbackResourceName(url) {
        try {
            return new URL(url).hostname.replace(/^www\./i, '') || '자료';
        } catch (_) {
            return '자료';
        }
    }

    function createId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }

        return `nai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function detectSourceType(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();

            if (host.endsWith('notion.site') || host.includes('notion.so')) {
                return 'Notion';
            }

            if (host.includes('dcinside.com')) {
                return 'DCInside';
            }

            return host || 'Web';
        } catch (_) {
            return 'Unknown';
        }
    }

    function isNotionUrl(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return (
                host === 'notion.so' ||
                host.endsWith('.notion.so') ||
                host === 'notion.site' ||
                host.endsWith('.notion.site')
            );
        } catch (_) {
            return false;
        }
    }

    function notionPageKey(url) {
        try {
            const parsed = new URL(url);
            const haystack = `${parsed.pathname}${parsed.search}`;
            const compact = haystack.match(/([0-9a-f]{32})(?:[^0-9a-f]|$)/i);

            if (compact) {
                return compact[1].toLowerCase();
            }

            const dashed = haystack.match(
                /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
            );

            if (dashed) {
                return dashed[1].replace(/-/g, '').toLowerCase();
            }

            parsed.hash = '';
            parsed.search = '';
            parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
            return parsed.toString().toLowerCase();
        } catch (_) {
            return String(url || '').trim().toLowerCase();
        }
    }

    function cleanDiscoveredUrl(candidate, baseUrl) {
        let value = String(candidate || '').trim();

        if (!value) return '';

        value = value
            .replace(/&amp;/g, '&')
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/^['\"]+|['\"]+$/g, '');

        try {
            const parsed = new URL(value, baseUrl);

            if (!/^https?:$/.test(parsed.protocol)) return '';

            parsed.hash = '';

            for (const key of [...parsed.searchParams.keys()]) {
                if (
                    /^utm_/i.test(key) ||
                    ['source', 'share', 'duplicate'].includes(key.toLowerCase())
                ) {
                    parsed.searchParams.delete(key);
                }
            }

            return parsed.toString();
        } catch (_) {
            return '';
        }
    }

    function isLikelyAssetUrl(url) {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname.toLowerCase();
            return /\.(?:txt|md|markdown|csv|json|pdf)(?:$|\?)/i.test(path);
        } catch (_) {
            return false;
        }
    }

    function isLikelyNotionChildPage(url, rootUrl) {
        try {
            const parsed = new URL(url);
            const root = new URL(rootUrl);
            const host = parsed.hostname.toLowerCase();
            const rootHost = root.hostname.toLowerCase();

            if (!/^https?:$/.test(parsed.protocol)) return false;
            if (isLikelyAssetUrl(parsed.toString())) return false;

            const notionHost =
                host === 'notion.so' ||
                host.endsWith('.notion.so') ||
                host === 'notion.site' ||
                host.endsWith('.notion.site');

            if (!notionHost) return false;

            if (host !== rootHost && !host.endsWith('.notion.so')) {
                return false;
            }

            const path = parsed.pathname.toLowerCase();
            const blocked = [
                '/login', '/signup', '/help', '/templates', '/product',
                '/pricing', '/download', '/desktop', '/front-static',
                '/api/', '/_next/', '/images/', '/assets/', '/fonts/'
            ];

            if (blocked.some(prefix => path.startsWith(prefix))) return false;

            if (host !== rootHost) {
                const hasPageId =
                    /[0-9a-f]{32}(?:[^0-9a-f]|$)/i.test(path) ||
                    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(path);

                if (!hasPageId) return false;
            }

            return true;
        } catch (_) {
            return false;
        }
    }

    function normalizeUrl(url) {
        const value = String(url || '').trim();
        const parsed = new URL(value);

        if (!/^https?:$/.test(parsed.protocol)) {
            throw new Error('http:// 또는 https:// URL만 사용할 수 있습니다.');
        }

        return parsed.toString();
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(String(text || ''));
            return true;
        } catch (_) {
            try {
                const ta = document.createElement('textarea');
                ta.value = String(text || '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                return true;
            } catch (_) {
                return false;
            }
        }
    }

    function encodeShareCodeText(text) {
        const bytes = new TextEncoder().encode(String(text || ''));
        let binary = '';
        const chunkSize = 0x8000;

        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }

        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    function decodeShareCodeText(encoded) {
        const normalized = String(encoded || '')
            .trim()
            .replace(/\s+/g, '')
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }

        return new TextDecoder().decode(bytes);
    }

    function createConceptShareCode(rawItem) {
        const item = normalizeConceptRecord(rawItem);
        const payload = {
            v: 1,
            kind: 'concept',
            name: String(item.name || '').trim(),
            tags: String(item.tags || '').trim(),
            negativeTags: String(item.negativeTags || '').trim(),
            characters: normalizeCharacterRows(item.characters).map(character => ({
                name: String(character.name || '').trim(),
                prompt: String(character.prompt || '').trim(),
                negativePrompt: String(character.negativePrompt || '').trim()
            })),
            note: String(item.note || '').trim(),
            sourceUrl: normalizedExternalUrl(item?.source?.url || '')
        };

        return SHARE_CODE_PREFIX + encodeShareCodeText(JSON.stringify(payload));
    }

    function createResourceShareCode(rawItem) {
        const item = normalizeResourceRecord(rawItem);
        const url = normalizedExternalUrl(item.url || '');
        if (!url) throw new Error('공유할 자료의 링크가 올바르지 않습니다.');

        const payload = {
            v: 1,
            kind: 'resource',
            name: String(item.name || '').trim(),
            url,
            note: String(item.note || '').trim()
        };

        return SHARE_CODE_PREFIX + encodeShareCodeText(JSON.stringify(payload));
    }

    function createMemoShareCode(rawItem) {
        const item = normalizeMemoRecord(rawItem);
        const content = String(item.content || '').trim();
        if (!content) throw new Error('공유할 메모 내용이 없습니다.');

        const payload = {
            v: 1,
            kind: 'memo',
            title: String(item.title || '').trim(),
            content
        };

        return SHARE_CODE_PREFIX + encodeShareCodeText(JSON.stringify(payload));
    }

    function parseShareCodePayload(value) {
        const raw = String(value || '').trim();
        if (!raw.startsWith(SHARE_CODE_PREFIX)) {
            throw new Error(`공유 코드는 ${SHARE_CODE_PREFIX} 로 시작해야 합니다.`);
        }

        let payload;
        try {
            payload = JSON.parse(
                decodeShareCodeText(raw.slice(SHARE_CODE_PREFIX.length))
            );
        } catch (_) {
            throw new Error('공유 코드를 읽을 수 없습니다. 코드가 잘렸거나 손상된 것 같습니다.');
        }

        if (
            payload?.v !== 1 ||
            !['concept', 'resource', 'memo'].includes(payload?.kind)
        ) {
            throw new Error('지원하지 않는 공유 코드 형식입니다.');
        }

        return payload;
    }

    function parseConceptShareCode(value) {
        const payload = parseShareCodePayload(value);
        if (payload.kind !== 'concept') {
            throw new Error('컨셉 공유 코드가 아닙니다.');
        }

        const concept = {
            suggestedName: String(payload.name || '').trim(),
            tags: String(payload.tags || '').trim(),
            negativeTags: String(payload.negativeTags || '').trim(),
            characters: normalizeCharacterRows(payload.characters),
            note: String(payload.note || '').trim(),
            sourceUrl: normalizedExternalUrl(payload.sourceUrl || ''),
            sourcePageTitle: ''
        };

        const hasCharacterContent = concept.characters.some(character =>
            !!String(character.prompt || '').trim() ||
            !!String(character.negativePrompt || '').trim()
        );

        if (!concept.suggestedName) {
            throw new Error('공유 코드에 컨셉 이름이 없습니다.');
        }

        if (!concept.tags && !concept.negativeTags && !hasCharacterContent) {
            throw new Error('공유 코드에 저장할 Prompt 내용이 없습니다.');
        }

        return concept;
    }

    function parseResourceShareCode(value) {
        const payload = parseShareCodePayload(value);
        if (payload.kind !== 'resource') {
            throw new Error('자료실 공유 코드가 아닙니다.');
        }

        const url = normalizedExternalUrl(payload.url || '');
        if (!url) throw new Error('공유 코드의 자료 링크가 올바르지 않습니다.');

        return {
            name: String(payload.name || '').trim() || fallbackResourceName(url),
            url,
            note: String(payload.note || '').trim()
        };
    }

    function parseMemoShareCode(value) {
        const payload = parseShareCodePayload(value);
        if (payload.kind !== 'memo') {
            throw new Error('메모 공유 코드가 아닙니다.');
        }

        const content = String(payload.content || '').trim();
        if (!content) throw new Error('공유 코드에 메모 내용이 없습니다.');

        return {
            title: String(payload.title || '').trim(),
            content
        };
    }


    function isVisiblePromptEditor(editor) {
        if (!editor || !editor.isConnected) return false;

        let node = editor;
        while (node && node.nodeType === 1) {
            const style = PAGE_WINDOW.getComputedStyle
                ? PAGE_WINDOW.getComputedStyle(node)
                : getComputedStyle(node);

            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0'
            ) {
                return false;
            }

            if (node.getAttribute?.('aria-hidden') === 'true') {
                return false;
            }

            node = node.parentElement;
        }

        const rect = editor.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    }

    function pickVisibleElement(nodes) {
        const list = [...(nodes || [])].filter(Boolean);
        return list.find(isVisiblePromptEditor) || list.find(node => node.isConnected) || null;
    }

    function getPromptDocuments() {
        const docs = [document];
        try {
            if (PAGE_WINDOW.document && PAGE_WINDOW.document !== document) {
                docs.push(PAGE_WINDOW.document);
            }
        } catch (_) {}
        return docs;
    }

    function uniqueElements(nodes) {
        return [...new Set([...(nodes || [])].filter(Boolean))];
    }

    function isMainPromptInputBox(box, kind) {
        if (!box || !box.isConnected) return false;
        if (box.closest('.character-prompt-input')) return false;

        const className = String(box.className || '').toLowerCase();
        const isNegative =
            className.includes('undesired-content') ||
            className.includes('negative');

        if (kind === 'negative') return isNegative;
        return !isNegative;
    }

    function getActiveMainPromptRoot() {
        const roots = uniqueElements(
            getPromptDocuments().flatMap(doc =>
                [...doc.querySelectorAll('.image-gen-prompt-main')]
            )
        );
        if (!roots.length) return null;

        const withVisibleEditor = roots.find(root =>
            [...root.querySelectorAll('[data-prompt-input="true"] .ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"]')]
                .some(isVisiblePromptEditor)
        );

        if (withVisibleEditor) return withVisibleEditor;

        const visibleRoot = roots.find(root => {
            if (!root.isConnected) return false;
            const style = PAGE_WINDOW.getComputedStyle
                ? PAGE_WINDOW.getComputedStyle(root)
                : getComputedStyle(root);
            const rect = root.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
        });

        return visibleRoot || roots[roots.length - 1] || null;
    }

    function waitMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function collectMainPromptEditors(kind) {
        const candidates = [];
        const roots = uniqueElements([
            getActiveMainPromptRoot(),
            ...getPromptDocuments().flatMap(doc =>
                [...doc.querySelectorAll('.image-gen-prompt-main')]
            )
        ]);

        const addEditor = editor => {
            if (!editor || !editor.isConnected) return;
            if (editor.closest('.character-prompt-input')) return;
            if (!editor.matches('.ProseMirror[contenteditable="true"]')) return;

            const inputBox = editor.closest('[data-prompt-input="true"], [class*="prompt-input-box-"]');
            if (inputBox && !isMainPromptInputBox(inputBox, kind)) return;

            const cls = String(inputBox?.className || '').toLowerCase();
            if (!inputBox) {
                const neighborhood = String(editor.parentElement?.parentElement?.className || '').toLowerCase();
                const looksNegative = cls.includes('undesired') || neighborhood.includes('undesired');
                if ((kind === 'negative') !== looksNegative) return;
            }

            candidates.push(editor);
        };

        const preferredSelectors = kind === 'negative'
            ? [
                '.prompt-input-box-undesired-content .ProseMirror[contenteditable="true"]',
                '[data-prompt-input="true"][class*="undesired"] .ProseMirror[contenteditable="true"]'
            ]
            : [
                '.prompt-input-box-prompt .ProseMirror[contenteditable="true"]',
                '[data-prompt-input="true"] .ProseMirror[contenteditable="true"]'
            ];

        for (const root of roots) {
            for (const selector of preferredSelectors) {
                root.querySelectorAll(selector).forEach(addEditor);
            }
        }

        for (const doc of getPromptDocuments()) {
            for (const selector of preferredSelectors) {
                doc.querySelectorAll(selector).forEach(addEditor);
            }

            doc.querySelectorAll('[data-prompt-input="true"] .ProseMirror[contenteditable="true"]')
                .forEach(addEditor);
        }

        return uniqueElements(candidates);
    }

    function findMainPromptEditor(kind) {
        return pickVisibleElement(collectMainPromptEditors(kind));
    }

    function findMainPromptButton(kind) {
        const label = kind === 'negative' ? 'Undesired Content' : 'Prompt';
        const candidates = [];
        const roots = uniqueElements([
            getActiveMainPromptRoot(),
            ...getPromptDocuments().flatMap(doc =>
                [...doc.querySelectorAll('.image-gen-prompt-main')]
            )
        ]);

        const addButtons = scope => {
            if (!scope?.querySelectorAll) return;
            for (const button of scope.querySelectorAll('button')) {
                if (String(button.textContent || '').trim() !== label) continue;
                if (button.closest('.character-prompt-input')) continue;
                candidates.push(button);
            }
        };

        roots.forEach(addButtons);
        getPromptDocuments().forEach(addButtons);

        const unique = uniqueElements(candidates);
        return unique.find(isVisibleUiElement) || unique.find(button => button.isConnected) || null;
    }

    function getMainPromptDiagnostics(kind) {
        try {
            const docs = getPromptDocuments();
            const mainRoots = uniqueElements(docs.flatMap(doc => [...doc.querySelectorAll('.image-gen-prompt-main')]));
            const promptBoxes = uniqueElements(docs.flatMap(doc => [...doc.querySelectorAll('[data-prompt-input="true"]')]));
            const proseMirrors = uniqueElements(docs.flatMap(doc => [...doc.querySelectorAll('.ProseMirror[contenteditable="true"]')]));
            const candidates = collectMainPromptEditors(kind);
            return `main:${mainRoots.length} / promptBox:${promptBoxes.length} / editor:${proseMirrors.length} / candidate:${candidates.length}`;
        } catch (_) {
            return '진단 실패';
        }
    }

    async function activateMainPrompt(kind) {
        const direct = findMainPromptEditor(kind);

        if (direct && isVisiblePromptEditor(direct)) {
            return { ok: true, editor: direct, clicked: false };
        }

        const button = findMainPromptButton(kind);

        if (!button) {
            if (direct) {
                return { ok: true, editor: direct, clicked: false };
            }

            return {
                ok: false,
                error:
                    kind === 'negative'
                        ? `NovelAI Undesired Content 입력창/버튼을 찾지 못했습니다. (${getMainPromptDiagnostics(kind)})`
                        : `NovelAI Base Prompt 입력창/버튼을 찾지 못했습니다. (${getMainPromptDiagnostics(kind)})`
            };
        }

        button.click();

        for (let i = 0; i < 30; i++) {
            await waitMs(50);
            const editor = findMainPromptEditor(kind);

            if (editor && isVisiblePromptEditor(editor)) {
                return { ok: true, editor, clicked: true };
            }
        }

        return {
            ok: false,
            error:
                kind === 'negative'
                    ? 'NovelAI Undesired Content 입력창이 열리지 않았습니다.'
                    : 'NovelAI Base Prompt 입력창이 열리지 않았습니다.'
        };
    }

    function promptText(value) {
        return String(value || '').replace(/\u200B/g, '');
    }

    function placeCaretAtPromptEnd(editor) {
        const paragraphs = [...editor.querySelectorAll('p')];
        const nonEmpty = paragraphs.filter(p => promptText(p.textContent).trim());
        const target = nonEmpty.length
            ? nonEmpty[nonEmpty.length - 1]
            : (paragraphs[paragraphs.length - 1] || editor);

        const selection = PAGE_WINDOW.getSelection
            ? PAGE_WINDOW.getSelection()
            : window.getSelection();
        const range = PAGE_WINDOW.document?.createRange
            ? PAGE_WINDOW.document.createRange()
            : document.createRange();

        range.selectNodeContents(target);
        range.collapse(false);

        selection.removeAllRanges();
        selection.addRange(range);

        return target;
    }

    async function insertIntoPromptEditor(editor, tags) {
        const cleanTags = String(tags || '').trim();

        if (!cleanTags) {
            return { ok: true, skipped: true };
        }

        if (!editor) {
            return {
                ok: false,
                error: 'NovelAI Prompt 입력창을 찾지 못했습니다.'
            };
        }

        try {
            editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (_) {}

        try {
            editor.focus({ preventScroll: true });
        } catch (_) {
            editor.focus();
        }

        const target = placeCaretAtPromptEnd(editor);
        const current = promptText(target.textContent).trimEnd();

        let insertion = cleanTags;

        if (current) {
            insertion = /,$/.test(current)
                ? `\n${cleanTags}`
                : `,\n${cleanTags}`;
        }

        const before = promptText(editor.textContent);
        let commandChanged = false;

        try {
            const pageDocument = PAGE_WINDOW.document || document;
            commandChanged = !!pageDocument.execCommand?.(
                'insertText',
                false,
                insertion
            );
        } catch (_) {
            commandChanged = false;
        }

        await waitMs(40);

        if (promptText(editor.textContent) !== before) {
            try {
                editor.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: insertion
                }));
            } catch (_) {}
            return { ok: true };
        }

        try {
            const selection = PAGE_WINDOW.getSelection
                ? PAGE_WINDOW.getSelection()
                : window.getSelection();

            if (selection && selection.rangeCount) {
                const range = selection.getRangeAt(0);
                const node = (PAGE_WINDOW.document || document).createTextNode(insertion);
                range.deleteContents();
                range.insertNode(node);
                range.setStartAfter(node);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);

                try {
                    editor.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        inputType: 'insertText',
                        data: insertion
                    }));
                } catch (_) {
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                }

                await waitMs(80);
            }
        } catch (_) {}

        if (promptText(editor.textContent) !== before) {
            return { ok: true };
        }

        try {
            const DT = PAGE_WINDOW.DataTransfer || DataTransfer;
            const CE = PAGE_WINDOW.ClipboardEvent || ClipboardEvent;

            if (typeof DT === 'function' && typeof CE === 'function') {
                const data = new DT();
                data.setData('text/plain', insertion);

                editor.dispatchEvent(
                    new CE('paste', {
                        bubbles: true,
                        cancelable: true,
                        clipboardData: data
                    })
                );

                await waitMs(80);
            }
        } catch (_) {}

        if (promptText(editor.textContent) !== before || commandChanged) {
            return { ok: true };
        }

        return {
            ok: false,
            error: 'Prompt 입력창은 찾았지만 태그 삽입 이벤트가 적용되지 않았습니다.'
        };
    }

    function isVisibleUiElement(element) {
        if (!element || !element.isConnected) return false;

        let node = element;
        while (node && node.nodeType === 1) {
            const style = PAGE_WINDOW.getComputedStyle
                ? PAGE_WINDOW.getComputedStyle(node)
                : getComputedStyle(node);

            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0'
            ) {
                return false;
            }

            if (node.getAttribute?.('aria-hidden') === 'true') {
                return false;
            }

            node = node.parentElement;
        }

        const rect = element.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    }

    function getCharacterPromptContainersRaw() {
        return [
            ...PAGE_WINDOW.document.querySelectorAll('.character-prompt-input')
        ];
    }

    function getCharacterPromptIndex(container) {
        if (!container) return 0;

        for (const className of [...(container.classList || [])]) {
            const match = /^character-prompt-input-(\d+)$/.exec(className);
            if (match) return Number(match[1]) || 0;
        }

        return 0;
    }

    function getLogicalCharacterPromptContainers() {
        const groups = new Map();

        for (const container of getCharacterPromptContainersRaw()) {
            const index = getCharacterPromptIndex(container);
            if (!index) continue;

            if (!groups.has(index)) groups.set(index, []);
            groups.get(index).push(container);
        }

        const logical = new Map();

        for (const [index, containers] of groups.entries()) {
            const picked =
                containers.find(isVisibleUiElement) ||
                containers[containers.length - 1] ||
                null;

            if (picked) logical.set(index, picked);
        }

        return logical;
    }

    function getCharacterPromptCount() {
        const indices = [...getLogicalCharacterPromptContainers().keys()];
        return indices.length ? Math.max(...indices) : 0;
    }

    let cachedAddCharacterButton = null;

    function getAddCharacterButtonCandidates() {
        const doc = PAGE_WINDOW.document;
        const headers = [
            ...doc.querySelectorAll('.image-gen-character-prompts-header')
        ];

        const buttons = headers
            .flatMap(header => [...header.querySelectorAll('button')])
            .filter(button => button && !button.disabled && button.isConnected);

        const unique = [...new Set(buttons)];

        if (
            cachedAddCharacterButton &&
            cachedAddCharacterButton.isConnected &&
            !cachedAddCharacterButton.disabled &&
            unique.includes(cachedAddCharacterButton)
        ) {
            return [
                cachedAddCharacterButton,
                ...unique.filter(button => button !== cachedAddCharacterButton)
            ];
        }

        return [
            ...unique.filter(isVisibleUiElement),
            ...unique.filter(button => !isVisibleUiElement(button))
        ];
    }

    function findCharacterPromptContainer(index) {
        const wanted = Math.max(1, Math.floor(Number(index) || 1));
        const logical = getLogicalCharacterPromptContainers();
        const direct = logical.get(wanted);
        if (direct) return direct;

        const doc = PAGE_WINDOW.document;
        const exact = [
            ...doc.querySelectorAll(`.character-prompt-input-${wanted}`)
        ];

        return (
            exact.find(isVisibleUiElement) ||
            exact[exact.length - 1] ||
            null
        );
    }

    function findCharacterPromptEditor(container, index, kind = 'prompt') {
        if (!container) return null;

        const selector = kind === 'negative'
            ? `.prompt-input-box-character-prompts-${index}-undesired-content .ProseMirror[contenteditable="true"]`
            : `.prompt-input-box-character-prompts-${index} .ProseMirror[contenteditable="true"]`;

        const editors = [...container.querySelectorAll(selector)];
        return pickVisibleElement(editors) || editors[editors.length - 1] || null;
    }

    function findCharacterTabButton(container, kind) {
        if (!container) return null;

        const label = kind === 'negative'
            ? 'Undesired Content'
            : 'Prompt';

        return [...container.querySelectorAll('button')].find(button =>
            String(button.textContent || '').trim() === label
        ) || null;
    }

    function getReactClickHandler(button) {
        if (!button) return null;

        const seen = new Set();
        let node = button;
        const stopAt = button.closest?.('.image-gen-character-prompts-header') || null;

        while (node) {
            try {
                const keys = Reflect.ownKeys(node);

                for (const key of keys) {
                    if (
                        typeof key === 'string' &&
                        key.startsWith('__reactProps$')
                    ) {
                        const props = node[key];
                        if (
                            props &&
                            typeof props.onClick === 'function' &&
                            !seen.has(props.onClick)
                        ) {
                            return {
                                handler: props.onClick,
                                currentTarget: node,
                                source: 'reactProps'
                            };
                        }
                    }
                }

                for (const key of keys) {
                    if (
                        typeof key !== 'string' ||
                        !key.startsWith('__reactFiber$')
                    ) {
                        continue;
                    }

                    let fiber = node[key];
                    let depth = 0;

                    while (fiber && depth++ < 4) {
                        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
                            if (
                                props &&
                                typeof props.onClick === 'function' &&
                                !seen.has(props.onClick)
                            ) {
                                return {
                                    handler: props.onClick,
                                    currentTarget: node,
                                    source: 'reactFiber'
                                };
                            }
                        }
                        fiber = fiber.return;
                    }
                }
            } catch (_) {}

            if (node === stopAt) break;
            node = node.parentElement;
        }

        return null;
    }

    async function invokeReactClickHandler(button) {
        const found = getReactClickHandler(button);
        if (!found) {
            return { ok: false, source: 'none' };
        }

        let defaultPrevented = false;
        let propagationStopped = false;

        const eventLike = {
            type: 'click',
            target: button,
            currentTarget: found.currentTarget || button,
            nativeEvent: null,
            button: 0,
            buttons: 0,
            detail: 1,
            defaultPrevented: false,
            preventDefault() {
                defaultPrevented = true;
                this.defaultPrevented = true;
            },
            stopPropagation() {
                propagationStopped = true;
            },
            isDefaultPrevented() {
                return defaultPrevented;
            },
            isPropagationStopped() {
                return propagationStopped;
            },
            persist() {},
            timeStamp: Date.now()
        };

        try {
            const result = found.handler.call(
                found.currentTarget || button,
                eventLike
            );

            if (result && typeof result.then === 'function') {
                await result;
            }

            return { ok: true, source: found.source };
        } catch (error) {
            console.warn(`[${APP_NAME}] React Character add handler failed:`, error);
            return {
                ok: false,
                source: found.source,
                error
            };
        }
    }

    function dispatchNovelAiButtonClick(button) {
        if (!button) return false;

        try {
            button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        } catch (_) {}

        try {
            button.focus?.({ preventScroll: true });
        } catch (_) {
            try { button.focus?.(); } catch (_) {}
        }

        try {
            const proto = PAGE_WINDOW.HTMLElement?.prototype;
            if (proto?.click) {
                proto.click.call(button);
                return true;
            }
        } catch (_) {}

        try {
            button.click();
            return true;
        } catch (_) {}

        try {
            const MouseEventCtor = PAGE_WINDOW.MouseEvent || MouseEvent;
            button.dispatchEvent(new MouseEventCtor('click', {
                bubbles: true,
                cancelable: true,
                composed: true,
                button: 0,
                view: PAGE_WINDOW
            }));
            return true;
        } catch (_) {}

        return false;
    }

    function findCharacterGenderChoiceButton(label = 'Other') {
        const doc = PAGE_WINDOW.document;
        const wanted = String(label || '').trim();

        const poppers = [
            ...doc.querySelectorAll('[data-popper-placement]')
        ];

        const matchingPoppers = poppers.filter(popper => {
            const buttons = [...popper.querySelectorAll('button')];
            const labels = buttons.map(button => String(button.textContent || '').trim());
            return labels.includes('Female') && labels.includes('Male') && labels.includes('Other');
        });

        const orderedPoppers = [
            ...matchingPoppers.filter(isVisibleUiElement),
            ...matchingPoppers.filter(popper => !isVisibleUiElement(popper))
        ];

        for (const popper of orderedPoppers) {
            const buttons = [...popper.querySelectorAll('button')];
            const exact = buttons.find(button =>
                !button.disabled &&
                button.isConnected &&
                String(button.textContent || '').trim() === wanted &&
                isVisibleUiElement(button)
            );
            if (exact) return exact;
        }

        return [...doc.querySelectorAll('button')].find(button =>
            !button.disabled &&
            button.isConnected &&
            String(button.textContent || '').trim() === wanted &&
            isVisibleUiElement(button) &&
            button.closest?.('[data-popper-placement]')
        ) || null;
    }

    async function waitForCharacterGenderChoiceButton(label = 'Other', timeoutMs = 1600) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const button = findCharacterGenderChoiceButton(label);
            if (button) return button;
            await waitMs(40);
        }

        return findCharacterGenderChoiceButton(label);
    }

    async function chooseCharacterGenderAndWait(before, label = 'Other') {
        const choiceButton = await waitForCharacterGenderChoiceButton(label, 1600);
        if (!choiceButton) {
            return {
                ok: false,
                reason: 'gender-menu-not-found',
                count: getCharacterPromptCount()
            };
        }

        const domClicked = dispatchNovelAiButtonClick(choiceButton);
        if (domClicked) {
            const afterDomChoice = await waitForCharacterCountAbove(before, 2600);
            if (afterDomChoice > before) {
                return {
                    ok: true,
                    count: afterDomChoice,
                    method: `menu-${String(label).toLowerCase()}`
                };
            }
        }

        const reactResult = await invokeReactClickHandler(choiceButton);
        if (reactResult.ok) {
            const afterReactChoice = await waitForCharacterCountAbove(before, 2600);
            if (afterReactChoice > before) {
                return {
                    ok: true,
                    count: afterReactChoice,
                    method: `menu-${String(label).toLowerCase()}-${reactResult.source}`
                };
            }
        }

        return {
            ok: false,
            reason: 'gender-choice-did-not-create',
            count: getCharacterPromptCount(),
            domClicked,
            reactHandlerFound: reactResult.source !== 'none',
            reactSource: reactResult.source
        };
    }

    async function tryCreateOneCharacter(before, button) {

        const alreadyOpenChoice = findCharacterGenderChoiceButton('Other');
        if (alreadyOpenChoice) {
            const existingMenuResult = await chooseCharacterGenderAndWait(before, 'Other');
            if (existingMenuResult.ok) return existingMenuResult;
        }

        const domClicked = dispatchNovelAiButtonClick(button);

        if (domClicked) {
            const afterDirectClick = await waitForCharacterCountAbove(before, 220);
            if (afterDirectClick > before) {
                return {
                    ok: true,
                    count: afterDirectClick,
                    method: 'dom-click-direct'
                };
            }

            const menuResult = await chooseCharacterGenderAndWait(before, 'Other');
            if (menuResult.ok) return menuResult;
        }

        const reactResult = await invokeReactClickHandler(button);

        if (reactResult.ok) {
            const afterReactDirect = await waitForCharacterCountAbove(before, 220);
            if (afterReactDirect > before) {
                return {
                    ok: true,
                    count: afterReactDirect,
                    method: reactResult.source
                };
            }

            const menuResult = await chooseCharacterGenderAndWait(before, 'Other');
            if (menuResult.ok) {
                return {
                    ...menuResult,
                    method: `${reactResult.source}->${menuResult.method}`
                };
            }
        }

        return {
            ok: false,
            count: getCharacterPromptCount(),
            domClicked,
            reactHandlerFound: reactResult.source !== 'none',
            reactSource: reactResult.source,
            menuDetected: Boolean(findCharacterGenderChoiceButton('Other'))
        };
    }

    async function waitForCharacterCountAbove(before, timeoutMs = 5000) {
        const doc = PAGE_WINDOW.document;

        if (getCharacterPromptCount() > before) {
            return getCharacterPromptCount();
        }

        return await new Promise(resolve => {
            let done = false;
            let observer = null;

            const finish = value => {
                if (done) return;
                done = true;
                try { observer?.disconnect(); } catch (_) {}
                clearTimeout(timer);
                resolve(value);
            };

            observer = new MutationObserver(() => {
                const count = getCharacterPromptCount();
                if (count > before) finish(count);
            });

            try {
                observer.observe(doc.body || doc.documentElement, {
                    childList: true,
                    subtree: true
                });
            } catch (_) {}

            const timer = setTimeout(() => {
                finish(getCharacterPromptCount());
            }, timeoutMs);
        });
    }

    async function ensureCharacterPromptCount(wantedCount) {
        const target = Math.max(0, Math.floor(Number(wantedCount) || 0));
        let safety = 0;

        while (getCharacterPromptCount() < target) {
            if (++safety > target + 12) {
                return {
                    ok: false,
                    error: 'NovelAI Character Prompt 생성 반복이 비정상적으로 길어 중단했습니다.'
                };
            }

            const before = getCharacterPromptCount();
            const addButtons = getAddCharacterButtonCandidates();

            if (!addButtons.length) {
                return {
                    ok: false,
                    error:
                        'NovelAI Character 추가 (+) 버튼 후보를 찾지 못했습니다. ' +
                        '(.image-gen-character-prompts-header button)'
                };
            }

            let created = null;
            const probeInfo = [];

            for (let candidateIndex = 0; candidateIndex < addButtons.length; candidateIndex++) {
                const candidate = addButtons[candidateIndex];

                const currentCount = getCharacterPromptCount();
                if (currentCount > before) {
                    created = {
                        ok: true,
                        count: currentCount,
                        method: 'late-update'
                    };
                    break;
                }

                const attempt = await tryCreateOneCharacter(before, candidate);
                const attemptCount = getCharacterPromptCount();
                const reactInfo = attempt.reactHandlerFound
                    ? attempt.reactSource
                    : 'none';
                const menuInfo = attempt.menuDetected ? 'menu' : 'no-menu';

                probeInfo.push(
                    `#${candidateIndex + 1}:${attempt.method || 'fail'}/${reactInfo}/${menuInfo}/${attemptCount}`
                );

                if (attempt.ok && attemptCount > before) {
                    cachedAddCharacterButton = candidate;
                    created = {
                        ...attempt,
                        count: attemptCount
                    };
                    break;
                }
            }

            const after = created?.count ?? getCharacterPromptCount();

            if (!created?.ok || after <= before) {
                return {
                    ok: false,
                    error:
                        `NovelAI Character 추가 버튼 후보 ${addButtons.length}개를 모두 눌렀지만 ` +
                        `Character가 생성되지 않았습니다. ` +
                        `(현재 ${before}개 / 필요 ${target}개 / ${probeInfo.join(', ') || '진단 없음'})`
                };
            }

            for (let i = 0; i < 40; i++) {
                const container = findCharacterPromptContainer(after);
                if (container?.querySelector('.ProseMirror[contenteditable="true"]')) {
                    break;
                }
                await waitMs(50);
            }
        }

        return {
            ok: true,
            count: getCharacterPromptCount()
        };
    }

    async function activateCharacterPrompt(index, kind) {
        const container = findCharacterPromptContainer(index);

        if (!container) {
            return {
                ok: false,
                error: `NovelAI Character ${index} 영역을 찾지 못했습니다.`
            };
        }

        let editor = findCharacterPromptEditor(container, index, kind);
        if (editor && isVisiblePromptEditor(editor)) {
            return { ok: true, editor, container, clicked: false };
        }

        const button = findCharacterTabButton(container, kind);

        if (!button) {
            if (editor) {
                return { ok: true, editor, container, clicked: false };
            }

            return {
                ok: false,
                error:
                    `NovelAI Character ${index}의 ` +
                    `${kind === 'negative' ? 'Undesired Content' : 'Prompt'} 입력창/탭을 찾지 못했습니다.`
            };
        }

        dispatchNovelAiButtonClick(button);

        for (let i = 0; i < 40; i++) {
            await waitMs(50);
            editor = findCharacterPromptEditor(container, index, kind);

            if (editor && isVisiblePromptEditor(editor)) {
                return { ok: true, editor, container, clicked: true };
            }
        }

        if (editor) {
            return { ok: true, editor, container, clicked: true };
        }

        return {
            ok: false,
            error:
                `NovelAI Character ${index}의 ` +
                `${kind === 'negative' ? 'Undesired Content' : 'Prompt'} 입력창을 찾지 못했습니다.`
        };
    }

    async function waitForCharacterEditorReady(index, timeoutMs = 3000) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const container = findCharacterPromptContainer(index);
            if (container?.querySelector('.ProseMirror[contenteditable="true"]')) {
                return container;
            }
            await waitMs(50);
        }

        return findCharacterPromptContainer(index);
    }

    async function insertConceptIntoNovelAI(item) {
        const normalized = normalizeConceptRecord(item);
        const positive = String(normalized.tags || '').trim();
        const negative = String(normalized.negativeTags || '').trim();
        const characters = normalizeCharacterRows(normalized.characters);

        const hasCharacterContent = characters.some(character =>
            character.prompt || character.negativePrompt
        );

        if (!positive && !negative && !hasCharacterContent) {
            return {
                ok: false,
                error: '삽입할 Prompt가 비어 있습니다.'
            };
        }

        if (positive) {
            const base = await activateMainPrompt('base');
            if (!base.ok) return base;

            const inserted = await insertIntoPromptEditor(base.editor, positive);
            if (!inserted.ok) return inserted;
        }

        if (negative) {
            const undesired = await activateMainPrompt('negative');
            if (!undesired.ok) return undesired;

            const inserted = await insertIntoPromptEditor(
                undesired.editor,
                negative
            );

            if (!inserted.ok) return inserted;
        }

        let insertedCharacters = 0;
        let insertedCharacterNegatives = 0;

        if (characters.length) {
            const ensured = await ensureCharacterPromptCount(characters.length);
            if (!ensured.ok) return ensured;

            for (let i = 0; i < characters.length; i++) {
                const character = characters[i];
                const characterIndex = i + 1;

                const readyContainer = await waitForCharacterEditorReady(characterIndex, 3000);
                if (!readyContainer) {
                    return {
                        ok: false,
                        error: `NovelAI Character ${characterIndex} 슬롯이 생성됐지만 입력창이 준비되지 않았습니다.`
                    };
                }

                if (character.prompt) {
                    const promptTab = await activateCharacterPrompt(
                        characterIndex,
                        'prompt'
                    );

                    if (!promptTab.ok) return promptTab;

                    const inserted = await insertIntoPromptEditor(
                        promptTab.editor,
                        character.prompt
                    );

                    if (!inserted.ok) return inserted;
                    insertedCharacters += 1;
                }

                if (character.negativePrompt) {
                    const negativeTab = await activateCharacterPrompt(
                        characterIndex,
                        'negative'
                    );

                    if (!negativeTab.ok) return negativeTab;

                    const inserted = await insertIntoPromptEditor(
                        negativeTab.editor,
                        character.negativePrompt
                    );

                    if (!inserted.ok) return inserted;
                    insertedCharacterNegatives += 1;
                }

                await activateCharacterPrompt(characterIndex, 'prompt');
            }
        }

        await activateMainPrompt('base');

        return {
            ok: true,
            insertedPositive: Boolean(positive),
            insertedNegative: Boolean(negative),
            insertedCharacters,
            insertedCharacterNegatives
        };
    }

    function nativeFetchWithTimeout(url, opts = {}) {
        const timeoutMs = Math.max(0, Number(opts.timeout || opts.timeoutMs) || 0);

        if (!timeoutMs || typeof AbortController !== 'function') {
            return fetch(url, {
                method: opts.method || 'GET',
                headers: opts.headers || {},
                body: opts.body || null
            });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        return fetch(url, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body || null,
            signal: controller.signal
        }).finally(() => clearTimeout(timer));
    }

    function gmFetch(url, opts = {}) {
        if (!GM_XHR) {
            return nativeFetchWithTimeout(url, opts);
        }

        return new Promise((resolve, reject) => {
            const handle = GM_XHR({
                method: opts.method || 'GET',
                url,
                headers: opts.headers || {},
                data: opts.body || null,
                responseType: 'text',
                timeout: Math.max(0, Number(opts.timeout || opts.timeoutMs) || 0),

                onload(response) {
                    const rawHeaders = String(response.responseHeaders || '');

                    resolve({
                        ok: response.status >= 200 && response.status < 300,
                        status: response.status,
                        text: () => Promise.resolve(response.responseText),
                        json: () => Promise.resolve(JSON.parse(response.responseText)),
                        headers: {
                            get(name) {
                                const target = String(name || '').toLowerCase();
                                const line = rawHeaders
                                    .split(/\r?\n/)
                                    .find(header => {
                                        const idx = header.indexOf(':');
                                        return idx >= 0 &&
                                            header.slice(0, idx).trim().toLowerCase() === target;
                                    });

                                return line
                                    ? line.slice(line.indexOf(':') + 1).trim()
                                    : null;
                            }
                        },
                        abort() {
                            try { handle.abort(); } catch (_) {}
                        }
                    });
                },

                onerror() {
                    reject(new Error('네트워크 오류'));
                },

                ontimeout() {
                    reject(new Error('요청 타임아웃'));
                },

                onabort() {
                    reject(new Error('요청 취소됨'));
                }
            });
        });
    }

    async function requestJson(url, opts = {}, label = 'API 요청') {
        const response = await gmFetch(url, {
            ...opts,
            timeout: opts.timeout || 90000
        });

        const raw = await response.text().catch(() => '');

        let data = null;

        try {
            data = raw ? JSON.parse(raw) : null;
        } catch (_) {}

        if (!response.ok) {
            const message =
                data?.error?.message ||
                data?.message ||
                raw.slice(0, 600) ||
                `HTTP ${response.status}`;

            const error = new Error(`${label} 실패: ${response.status} ${message}`);
            error.status = response.status;
            throw error;
        }

        if (data === null) {
            throw new Error(`${label} 응답이 JSON이 아닙니다.`);
        }

        return data;
    }

    function getGeminiResponseText(json) {
        for (const candidate of json?.candidates || []) {
            const text = (candidate?.content?.parts || [])
                .filter(part => part && typeof part.text === 'string' && !part.thought)
                .map(part => part.text)
                .join('')
                .trim();

            if (text) return text;
        }

        return '';
    }

    function getUrlContextStatus(json) {
        const metadata =
            json?.candidates?.[0]?.urlContextMetadata ||
            json?.candidates?.[0]?.url_context_metadata ||
            null;

        const rows =
            metadata?.urlMetadata ||
            metadata?.url_metadata ||
            [];

        if (!Array.isArray(rows) || !rows.length) {
            return null;
        }

        return rows.map(row => ({
            url: row.retrievedUrl || row.retrieved_url || '',
            status: row.urlRetrievalStatus || row.url_retrieval_status || ''
        }));
    }

    function parseServiceAccountJson(value) {
        try {
            const parsed = JSON.parse(String(value || ''));

            if (!parsed.client_email || !parsed.private_key) {
                return {
                    ok: false,
                    error: 'client_email 또는 private_key가 없습니다.'
                };
            }

            return {
                ok: true,
                projectId: parsed.project_id || '',
                clientEmail: parsed.client_email,
                privateKey: parsed.private_key,
                tokenUri:
                    parsed.token_uri ||
                    'https://oauth2.googleapis.com/token'
            };
        } catch (_) {
            return {
                ok: false,
                error: 'Service Account JSON 파싱 실패'
            };
        }
    }

    function base64Url(value) {
        let bytes;

        if (typeof value === 'string') {
            bytes = new TextEncoder().encode(value);
        } else if (value instanceof ArrayBuffer) {
            bytes = new Uint8Array(value);
        } else {
            bytes = value;
        }

        let binary = '';

        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }

        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    function pemToArrayBuffer(pem) {
        const base64 = String(pem || '')
            .replace(/-----[A-Z ]+-----/g, '')
            .replace(/\s+/g, '');

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return bytes.buffer;
    }

    async function getVertexAccessToken(serviceAccount, cacheKey = 'default') {
        const cacheId = `${cacheKey}:${serviceAccount.clientEmail}`;
        const now = Math.floor(Date.now() / 1000);
        const cached = tokenCache[cacheId];

        if (cached && cached.token && cached.expiry > now + 60) {
            return cached.token;
        }

        const header = base64Url(JSON.stringify({
            alg: 'RS256',
            typ: 'JWT'
        }));

        const claim = base64Url(JSON.stringify({
            iss: serviceAccount.clientEmail,
            sub: serviceAccount.clientEmail,
            aud: serviceAccount.tokenUri,
            iat: now,
            exp: now + 3600,
            scope: 'https://www.googleapis.com/auth/cloud-platform'
        }));

        const signingInput = `${header}.${claim}`;

        const key = await crypto.subtle.importKey(
            'pkcs8',
            pemToArrayBuffer(serviceAccount.privateKey),
            {
                name: 'RSASSA-PKCS1-v1_5',
                hash: 'SHA-256'
            },
            false,
            ['sign']
        );

        const signature = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            key,
            new TextEncoder().encode(signingInput)
        );

        const assertion = `${signingInput}.${base64Url(signature)}`;

        const tokenData = await requestJson(
            serviceAccount.tokenUri,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body:
                    'grant_type=' +
                    encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
                    '&assertion=' +
                    encodeURIComponent(assertion),
                timeout: 30000
            },
            'Vertex OAuth 토큰 교환'
        );

        tokenCache[cacheId] = {
            token: tokenData.access_token,
            expiry: now + Number(tokenData.expires_in || 3600)
        };

        return tokenData.access_token;
    }

    function resolveVertexEndpoint(location) {
        const value = String(location || 'global').trim() || 'global';

        return {
            location: value,
            host:
                value === 'global'
                    ? 'aiplatform.googleapis.com'
                    : `${value}-aiplatform.googleapis.com`
        };
    }

    function extractBalancedObjectLiteral(source, startIndex = 0) {
        const src = String(source || '');
        const open = src.indexOf('{', startIndex);

        if (open < 0) return '';

        let depth = 0;
        let quote = '';
        let escaped = false;

        for (let i = open; i < src.length; i++) {
            const ch = src[i];

            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }

                if (ch === '\\') {
                    escaped = true;
                    continue;
                }

                if (ch === quote) {
                    quote = '';
                }

                continue;
            }

            if (ch === '"' || ch === "'" || ch === '`') {
                quote = ch;
                continue;
            }

            if (ch === '{') depth++;

            if (ch === '}') {
                depth--;

                if (depth === 0) {
                    return src.slice(open, i + 1);
                }
            }
        }

        return '';
    }

    function parseFirebaseConfig(value) {
        const source = String(value || '').trim();

        if (!source) return null;

        try {
            if (source.startsWith('{')) {
                try {
                    return JSON.parse(source);
                } catch (_) {
                    return new Function(`"use strict"; return (${source});`)();
                }
            }

            const assignment = source.search(/firebaseConfig\s*=/i);

            if (assignment >= 0) {
                const objectLiteral = extractBalancedObjectLiteral(source, assignment);

                if (objectLiteral) {
                    return new Function(
                        `"use strict"; return (${objectLiteral});`
                    )();
                }
            }

            const initializeAppIndex = source.search(/initializeApp\s*\(/i);

            if (initializeAppIndex >= 0) {
                const objectLiteral = extractBalancedObjectLiteral(
                    source,
                    initializeAppIndex
                );

                if (objectLiteral) {
                    return new Function(
                        `"use strict"; return (${objectLiteral});`
                    )();
                }
            }

            const firstObject = extractBalancedObjectLiteral(source, 0);

            if (firstObject && /apiKey|projectId/i.test(firstObject)) {
                return new Function(
                    `"use strict"; return (${firstObject});`
                )();
            }
        } catch (_) {}

        return null;
    }

    function loadFirebaseSdk() {
        if (PAGE_WINDOW.__naiConceptLoaderFirebaseSdk) {
            return Promise.resolve(PAGE_WINDOW.__naiConceptLoaderFirebaseSdk);
        }

        if (firebaseSdkPromise) {
            return firebaseSdkPromise;
        }

        firebaseSdkPromise = new Promise((resolve, reject) => {
            const eventName = 'nai-concept-loader-firebase-ready';
            const timeout = setTimeout(() => {
                firebaseSdkPromise = null;
                reject(new Error('Firebase SDK 로드 타임아웃'));
            }, 20000);

            const onReady = () => {
                clearTimeout(timeout);
                const sdk = PAGE_WINDOW.__naiConceptLoaderFirebaseSdk;

                if (!sdk) {
                    firebaseSdkPromise = null;
                    reject(new Error('Firebase SDK 초기화 실패'));
                    return;
                }

                resolve(sdk);
            };

            PAGE_WINDOW.addEventListener(eventName, onReady, { once: true });

            const script = document.createElement('script');
            script.type = 'module';
            script.textContent = `
                import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
                import {
                    getAI,
                    getGenerativeModel,
                    GoogleAIBackend,
                    VertexAIBackend
                } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-ai.js";

                window.__naiConceptLoaderFirebaseSdk = {
                    initializeApp,
                    getAI,
                    getGenerativeModel,
                    GoogleAIBackend,
                    VertexAIBackend
                };

                window.dispatchEvent(
                    new CustomEvent("${eventName}")
                );
            `;

            script.onerror = () => {
                clearTimeout(timeout);
                firebaseSdkPromise = null;
                reject(new Error('Firebase SDK 스크립트 로드 실패'));
            };

            (document.head || document.documentElement).appendChild(script);
        });

        return firebaseSdkPromise;
    }

    async function callGeminiDeveloper(prompt, settings, options = {}) {
        const model = settings.geminiModel || DEFAULT_MODEL;
        const key = String(settings.geminiKey || '').trim();

        if (!key) {
            throw new Error('Gemini API Key가 없습니다.');
        }

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: String(prompt || '') }]
                }
            ]
        };

        if (options.useUrlContext) {
            body.tools = [{ urlContext: {} }];
        }

        if (options.jsonMode && !options.useUrlContext) {
            body.generationConfig = {
                responseMimeType: 'application/json'
            };
        }

        const json = await requestJson(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': key
                },
                body: JSON.stringify(body),
                timeout: 90000
            },
            'Gemini API'
        );

        const text = getGeminiResponseText(json);

        if (!text) {
            const reason =
                json?.promptFeedback?.blockReason ||
                json?.candidates?.[0]?.finishReason ||
                '응답 없음';

            throw new Error(`Gemini 응답이 비어 있습니다: ${reason}`);
        }

        return {
            text,
            raw: json,
            urlStatus: getUrlContextStatus(json)
        };
    }

    async function callVertex(prompt, settings, options = {}) {
        const parsed = parseServiceAccountJson(settings.vertexJson);

        if (!parsed.ok) {
            throw new Error(parsed.error);
        }

        const projectId =
            String(settings.vertexProjectId || '').trim() ||
            parsed.projectId;

        if (!projectId) {
            throw new Error('Vertex Project ID가 없습니다.');
        }

        const model = settings.vertexModel || DEFAULT_MODEL;
        const endpoint = resolveVertexEndpoint(settings.vertexLocation);
        const token = await getVertexAccessToken(parsed, 'nai-concept-loader');

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: String(prompt || '') }]
                }
            ]
        };

        if (options.useUrlContext) {
            body.tools = [{ urlContext: {} }];
        }

        if (options.jsonMode && !options.useUrlContext) {
            body.generationConfig = {
                responseMimeType: 'application/json'
            };
        }

        const url =
            `https://${endpoint.host}/v1beta1/projects/${encodeURIComponent(projectId)}` +
            `/locations/${encodeURIComponent(endpoint.location)}` +
            `/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

        let json;

        try {
            json = await requestJson(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify(body),
                    timeout: 90000
                },
                'Vertex AI'
            );
        } catch (error) {
            if (error?.status === 401) {
                for (const key of Object.keys(tokenCache)) {
                    if (key.includes(parsed.clientEmail)) {
                        delete tokenCache[key];
                    }
                }

                const refreshedToken = await getVertexAccessToken(
                    parsed,
                    'nai-concept-loader'
                );

                json = await requestJson(
                    url,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${refreshedToken}`
                        },
                        body: JSON.stringify(body),
                        timeout: 90000
                    },
                    'Vertex AI'
                );
            } else {
                throw error;
            }
        }

        const text = getGeminiResponseText(json);

        if (!text) {
            const reason =
                json?.promptFeedback?.blockReason ||
                json?.candidates?.[0]?.finishReason ||
                '응답 없음';

            throw new Error(`Vertex 응답이 비어 있습니다: ${reason}`);
        }

        return {
            text,
            raw: json,
            urlStatus: getUrlContextStatus(json)
        };
    }

    async function callFirebase(prompt, settings, options = {}) {
        const config = parseFirebaseConfig(settings.firebaseConfig);

        if (!config?.apiKey || !config?.projectId) {
            throw new Error(
                'Firebase Config에서 apiKey/projectId를 찾지 못했습니다.'
            );
        }

        const sdk = await loadFirebaseSdk();
        const backendType = settings.firebaseBackend || 'vertex';
        const location = settings.firebaseLocation || 'global';
        const modelName = settings.firebaseModel || DEFAULT_MODEL;

        const appName =
            `nai-concept-loader-${simpleHash(config.apiKey + ':' + config.projectId)}`;

        let app = firebaseAppCache[appName];

        if (!app) {
            app = sdk.initializeApp(config, appName);
            firebaseAppCache[appName] = app;
        }

        const aiKey = `${appName}|${backendType}|${location}`;
        let ai = firebaseAiCache[aiKey];

        if (!ai) {
            const backend =
                backendType === 'googleai'
                    ? new sdk.GoogleAIBackend()
                    : new sdk.VertexAIBackend(location);

            ai = sdk.getAI(app, { backend });
            firebaseAiCache[aiKey] = ai;
        }

        const modelKey =
            `${aiKey}|${modelName}|${options.useUrlContext ? 'url' : 'plain'}|` +
            `${options.jsonMode ? 'json' : 'text'}`;

        let model = firebaseModelCache[modelKey];

        if (!model) {
            const modelOptions = {
                model: modelName
            };

            if (options.useUrlContext) {
                modelOptions.tools = [{ urlContext: {} }];
            }

            if (options.jsonMode && !options.useUrlContext) {
                modelOptions.generationConfig = {
                    responseMimeType: 'application/json'
                };
            }

            model = sdk.getGenerativeModel(ai, modelOptions);
            firebaseModelCache[modelKey] = model;
        }

        const result = await Promise.race([
            model.generateContent(String(prompt || '')),
            new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error('Firebase 생성 요청 타임아웃')),
                    90000
                );
            })
        ]);

        const text = result?.response?.text?.() || '';

        if (!text) {
            throw new Error('Firebase AI 응답이 비어 있습니다.');
        }

        const candidate = result?.response?.candidates?.[0] || null;
        const rawMetadata =
            candidate?.urlContextMetadata ||
            candidate?.url_context_metadata ||
            null;

        let urlStatus = null;

        if (rawMetadata) {
            const rows =
                rawMetadata.urlMetadata ||
                rawMetadata.url_metadata ||
                [];

            if (Array.isArray(rows) && rows.length) {
                urlStatus = rows.map(row => ({
                    url: row.retrievedUrl || row.retrieved_url || '',
                    status:
                        row.urlRetrievalStatus ||
                        row.url_retrieval_status ||
                        ''
                }));
            }
        }

        return {
            text,
            raw: result,
            urlStatus
        };
    }

    async function callProvider(prompt, settings, options = {}) {
        const provider = settings.provider || 'gemini';

        if (provider === 'gemini') {
            return callGeminiDeveloper(prompt, settings, options);
        }

        if (provider === 'vertex') {
            return callVertex(prompt, settings, options);
        }

        if (provider === 'firebase') {
            return callFirebase(prompt, settings, options);
        }

        throw new Error(`지원하지 않는 provider: ${provider}`);
    }

    function buildAnalyzePrompt(url, pageText = '', settings = {}) {
        const sourcePart = pageText
            ? `
아래는 페이지에서 직접 가져온 텍스트다.
이 텍스트만 근거로 분석하라.

--- PAGE TEXT START ---
${pageText}
--- PAGE TEXT END ---
`
            : `
다음 공개 URL을 URL Context 도구로 직접 읽어라:
${url}
`;

        return `
너는 NovelAI 이미지 생성용 "공유 Prompt 세트"를 원문 그대로 추출하는 분석기다.

${sourcePart}

가장 중요한 규칙:
- 너의 역할은 "창작/개선"이 아니라 "정확한 추출"이다.
- 태그를 추가, 삭제, 번역, 재정렬, 교정, 요약하지 마라.
- 원문의 쉼표, 가중치 문법(::, {}, [] 등), # 접두사, 순서를 그대로 보존하라.
- 원문에 의미 있는 줄바꿈이 있으면 문자열 내부에서도 그대로 보존하라.
- 하나의 완성된 Prompt 세트 안에 공통 Prompt와 Character Prompt가 있으면 절대로 여러 concept로 쪼개지 마라.
- "공통 Prompt", "Base Prompt", "Common Prompt", "Scene Prompt" 등 전체에 적용되는 Prompt는 tags에 넣어라.
- "Character 1 Prompt", "Character 2 Prompt", "Character N Prompt"처럼 캐릭터 번호/라벨이 명시된 경우에만 characters 배열로 분리하라.
- 단순히 줄이 나뉘어 있거나 문단이 여러 개라는 이유만으로 Character Prompt라고 추측하지 마라. 그런 경우에는 tags 하나에 줄바꿈을 보존해서 넣어라.
- "Negative Prompt", "Undesired Content", "UC", "Negative" 등 전체 네거티브 영역은 negativeTags에 넣어라.
- "Character 1 Undesired Content", "Character 1 Negative Prompt"처럼 특정 캐릭터에 명시적으로 붙은 네거티브는 해당 characters 항목의 negativePrompt에 넣어라.
- 공통 Prompt / Character 1 / Character 2는 서로 다른 컨셉이 아니라 같은 세트의 구성요소다.
- 페이지에 서로 완전히 독립된 여러 예시/프리셋/세트가 명확히 존재할 때만 concepts를 여러 개 반환하라.
- 설명문, 목차, 사용법, 버튼명, 이미지 캡션, 문장형 해설은 Prompt 태그에 포함하지 마라.
- 단, 해당 Prompt 세트 바로 주변에 작성자가 남긴 짧은 사용 팁/주의사항/추천 조합/수정 지시가 있으면 note에 보존하라.
- note에는 원문에서 실제 확인되는 내용만 넣고 새 설명을 만들거나 요약·추측하지 마라. 짧은 원문 문구의 의미와 표현을 최대한 유지하라.
- 해당 세트와 직접 관계없는 잡담, 목차, 긴 일반 설명, 페이지 소개는 note에도 넣지 마라.
- 메모로 남길 만한 원문이 없으면 note는 빈 문자열로 반환하라.
- suggestedName은 실제 태그의 핵심 장면/용도/효과를 나타내는 간략한 제목으로 만든다.
- suggestedName 앞에 "Nai 공유 태그 -", "NAI 공유 태그 -", "공유 태그 -", "Prompt -", "프롬프트 -", "태그 -" 같은 상투적인 접두어를 절대 붙이지 마라.
- 페이지 제목을 기계적으로 복사하지 말고 태그 내용을 기준으로 "노트북 셀카", "피임 필수"처럼 짧고 구체적인 이름을 제안하라.
- 실제 공유 Prompt인지 확신이 약하면 제외하라.
- characters가 없으면 빈 배열 []로 반환하라.
- JSON 하나만 출력하고 마크다운 코드블록/설명은 금지한다.

반환 형식:
{
  "pageTitle": "페이지 제목 또는 빈 문자열",
  "concepts": [
    {
      "suggestedName": "태그 내용을 나타내는 짧고 구체적인 제목",
      "sectionLabel": "원문의 세트/프리셋 라벨 또는 빈 문자열",
      "tags": "Base/Common/Positive Prompt. 없으면 빈 문자열",
      "negativeTags": "전체 Negative/Undesired Content. 없으면 빈 문자열",
      "characters": [
        {
          "name": "Character 1",
          "prompt": "해당 캐릭터 Prompt. 없으면 빈 문자열",
          "negativePrompt": "해당 캐릭터 Negative/Undesired Content. 없으면 빈 문자열"
        }
      ],
      "note": "해당 세트 주변의 작성자 사용 팁/주의사항 원문. 없으면 빈 문자열"
    }
  ]
}

`.trim();
    }

    function stripJsonFence(text) {
        let value = String(text || '').trim();

        value = value
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        return value;
    }

    function findBalancedJsonObject(text) {
        const src = String(text || '');
        const start = src.indexOf('{');

        if (start < 0) return '';

        let depth = 0;
        let quote = '';
        let escaped = false;

        for (let i = start; i < src.length; i++) {
            const ch = src[i];

            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }

                if (ch === '\\') {
                    escaped = true;
                    continue;
                }

                if (ch === quote) {
                    quote = '';
                }

                continue;
            }

            if (ch === '"') {
                quote = '"';
                continue;
            }

            if (ch === '{') depth++;

            if (ch === '}') {
                depth--;

                if (depth === 0) {
                    return src.slice(start, i + 1);
                }
            }
        }

        return '';
    }

    function parseLooseJsonObject(text) {
        const cleaned = stripJsonFence(text);
        const attempts = [
            cleaned,
            findBalancedJsonObject(cleaned)
        ].filter(Boolean);

        for (const candidate of attempts) {
            try {
                const parsed = JSON.parse(candidate);

                if (parsed && typeof parsed === 'object') {
                    return parsed;
                }
            } catch (_) {}
        }

        throw new Error('AI 응답 JSON 파싱에 실패했습니다.');
    }

    function parseAnalysisJson(text) {
        const parsed = parseLooseJsonObject(text);
        const concepts = Array.isArray(parsed.concepts)
            ? parsed.concepts
            : [];

        const normalized = concepts
            .map((item, index) => {
                const tags = String(
                    item?.tags ??
                    item?.basePrompt ??
                    item?.prompt ??
                    item?.positivePrompt ??
                    ''
                ).trim();

                const negativeTags = String(
                    item?.negativeTags ??
                    item?.negativePrompt ??
                    item?.undesiredContent ??
                    ''
                ).trim();

                const characters = normalizeCharacterRows(
                    item?.characters ??
                    item?.characterPrompts ??
                    []
                );

                if (!tags && !negativeTags && !characters.length) {
                    return null;
                }

                return {
                    id: createId(),
                    selected: true,
                    suggestedName:
                        String(item?.suggestedName || '').trim() ||
                        `컨셉 ${index + 1}`,
                    sectionLabel: String(
                        item?.sectionLabel ??
                        item?.setLabel ??
                        ''
                    ).trim(),
                    tags,
                    negativeTags,
                    characters,
                    note: String(item?.note || '').trim()
                };
            })
            .filter(Boolean);

        return {
            pageTitle: String(parsed.pageTitle || '').trim(),
            concepts: normalized
        };
    }

    async function fetchPublicPageSnapshot(url) {
        const response = await gmFetch(url, {
            method: 'GET',
            headers: {
                Accept:
                    'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache'
            },
            timeout: 20000
        });

        if (!response.ok) {
            throw new Error(`원문 직접 가져오기 실패: HTTP ${response.status}`);
        }

        const raw = await response.text();

        if (!raw) {
            throw new Error('원문 직접 가져오기 결과가 비어 있습니다.');
        }

        const contentType = response.headers?.get?.('content-type') || '';
        const links = [];
        let title = '';
        let text = '';

        if (
            contentType.includes('text/plain') ||
            contentType.includes('application/json')
        ) {
            text = raw;
        } else {
            const doc = new DOMParser().parseFromString(raw, 'text/html');
            title = doc.title || '';

            for (const anchor of doc.querySelectorAll('a[href]')) {
                const resolved = cleanDiscoveredUrl(
                    anchor.getAttribute('href'),
                    url
                );

                if (!resolved) continue;

                links.push({
                    url: resolved,
                    title: String(anchor.textContent || '').trim()
                });
            }

            const absoluteMatches = raw.match(
                /https?:\\?\/\\?\/[^\s"'<>\\]+/gi
            ) || [];

            for (const candidate of absoluteMatches.slice(0, 400)) {
                const resolved = cleanDiscoveredUrl(candidate, url);
                if (resolved) links.push({ url: resolved, title: '' });
            }

            for (const element of doc.querySelectorAll(
                'script, style, noscript, svg, canvas'
            )) {
                element.remove();
            }

            text = (doc.body?.textContent || doc.documentElement?.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n[ \t]+/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
        }

        const combined = title
            ? `PAGE TITLE: ${title}\n\n${text}`
            : text;

        return {
            raw,
            title,
            text: combined.slice(0, 140000),
            links
        };
    }

    async function fetchPublicPageText(url) {
        const snapshot = await fetchPublicPageSnapshot(url);

        if (snapshot.text.length < 20) {
            throw new Error('원문에서 읽을 수 있는 텍스트를 찾지 못했습니다.');
        }

        return snapshot.text;
    }

    function urlContextClearlyFailed(urlStatus) {
        if (!Array.isArray(urlStatus) || !urlStatus.length) {
            return false;
        }

        return urlStatus.every(item => {
            const status = String(item?.status || '');
            return !status.includes('SUCCESS');
        });
    }

    function conceptFingerprint(tags, negativeTags = '', characters = []) {
        const compact = value => String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*,\s*/g, ',')
            .trim()
            .toLowerCase();

        const positive = compact(tags);
        const negative = compact(negativeTags);

        const characterPart = normalizeCharacterRows(characters)
            .map((character, index) => [
                compact(character.name || `Character ${index + 1}`),
                compact(character.prompt),
                compact(character.negativePrompt)
            ].join('|'))
            .join('\n');

        return [
            positive,
            '---NEG---',
            negative,
            '---CHARACTERS---',
            characterPart
        ].join('\n').trim();
    }

    function sleepMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function notionCrawlerJobRead() {
        const job = GM_getValue(NOTION_BROWSER_JOB_KEY, null);
        return job && typeof job === 'object' ? job : null;
    }

    function notionCrawlerJobWrite(job) {
        GM_setValue(NOTION_BROWSER_JOB_KEY, {
            ...job,
            updatedAt: Date.now()
        });
    }

    function notionCrawlerCurrentKey(url) {
        return notionPageKey(url);
    }

    function notionCrawlerBadge(text) {
        if (!document.body) return;

        let badge = document.getElementById('nai-notion-crawler-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'nai-notion-crawler-badge';
            badge.style.cssText = [
                'position:fixed',
                'right:14px',
                'top:14px',
                'z-index:2147483647',
                'max-width:360px',
                'padding:10px 12px',
                'border-radius:7px',
                'background:rgba(24,26,42,.94)',
                'color:white',
                'font:12px/1.5 system-ui,sans-serif',
                'box-shadow:0 8px 30px rgba(0,0,0,.35)',
                'white-space:pre-wrap',
                'pointer-events:none'
            ].join(';');
            document.body.appendChild(badge);
        }

        badge.textContent = text;
    }

    async function waitForNotionRenderedDom() {
        if (document.readyState === 'loading') {
            await new Promise(resolve => {
                document.addEventListener('DOMContentLoaded', resolve, { once: true });
            });
        }

        const started = Date.now();
        let stableRounds = 0;
        let previousSignature = '';

        while (Date.now() - started < NOTION_BROWSER_PAGE_SETTLE_MS) {
            const body = document.body;
            const textLength = String(body?.innerText || '').trim().length;
            const anchorCount = document.querySelectorAll('a[href]').length;
            const signature = `${textLength}:${anchorCount}`;

            if (textLength >= 30 && signature === previousSignature) {
                stableRounds += 1;
            } else {
                stableRounds = 0;
            }

            previousSignature = signature;

            if (stableRounds >= 3) break;
            await sleepMs(500);
        }

        try {
            const maxY = Math.max(
                document.body?.scrollHeight || 0,
                document.documentElement?.scrollHeight || 0
            );
            if (maxY > innerHeight * 1.5) {
                scrollTo(0, maxY);
                await sleepMs(700);
                scrollTo(0, 0);
                await sleepMs(350);
            }
        } catch (_) {}
    }

    function extractRenderedNotionLinks(currentUrl, rootUrl) {
        const candidates = [];

        const pushCandidate = (raw, title = '') => {
            const resolved = cleanDiscoveredUrl(raw, currentUrl);
            if (!resolved) return;
            if (!isNotionUrl(resolved)) return;
            if (!isLikelyNotionChildPage(resolved, rootUrl)) return;
            if (notionCrawlerCurrentKey(resolved) === notionCrawlerCurrentKey(currentUrl)) return;

            candidates.push({
                url: resolved,
                title: String(title || '').trim().slice(0, 180)
            });
        };

        for (const anchor of document.querySelectorAll('a[href]')) {
            pushCandidate(
                anchor.getAttribute('href'),
                anchor.textContent || anchor.getAttribute('aria-label') || ''
            );
        }

        for (const el of document.querySelectorAll('[role="link"], [data-href], [data-url]')) {
            const raw =
                el.getAttribute('href') ||
                el.getAttribute('data-href') ||
                el.getAttribute('data-url');

            if (raw) {
                pushCandidate(
                    raw,
                    el.textContent || el.getAttribute('aria-label') || ''
                );
            }
        }

        try {
            const html = document.documentElement?.innerHTML || '';
            const rootHost = new URL(rootUrl).hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const absoluteRe = new RegExp(
                `https?:\\/\\/${rootHost}\\/[^\\s\"'<>\\\\]{1,260}`,
                'gi'
            );
            const relativeRe = /[\"'](\/[^\"'<>]{0,220}[0-9a-f]{32}[^\"'<>]{0,80})[\"']/gi;

            for (const match of html.match(absoluteRe) || []) {
                pushCandidate(match, '');
            }

            let m;
            let guard = 0;
            while ((m = relativeRe.exec(html)) && guard < 250) {
                guard += 1;
                pushCandidate(m[1], '');
            }
        } catch (_) {}

        const map = new Map();
        for (const item of candidates) {
            const key = notionCrawlerCurrentKey(item.url);
            if (!key || map.has(key)) continue;
            map.set(key, item);
        }

        return [...map.values()];
    }

    function extractRenderedNotionText() {
        const preferred =
            document.querySelector('main') ||
            document.querySelector('[role="main"]') ||
            document.body;

        let text = String(preferred?.innerText || document.body?.innerText || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();

        text = text.replace(/^(?:NAI Archive|NAI Concept Loader)[\s\S]{0,250}?\n\n/i, '');

        return text.slice(0, 140000);
    }

    async function runNotionRenderedCrawlerHelper() {
        let job = notionCrawlerJobRead();
        if (!job || job.status !== 'running') return;

        await waitForNotionRenderedDom();

        job = notionCrawlerJobRead();
        if (!job || job.status !== 'running') return;

        const currentUrl = cleanDiscoveredUrl(location.href, job.rootUrl) || location.href;
        const currentKey = notionCrawlerCurrentKey(currentUrl);
        const currentDepth = Number(job.current?.depth || 0);

        notionCrawlerBadge(
            `${APP_NAME}\nNotion 실제 화면 수집 중\n` +
            `${(job.visited || []).length + 1}/${NOTION_MAX_PAGES} · 깊이 ${currentDepth}/${NOTION_MAX_DEPTH}`
        );

        const text = extractRenderedNotionText();
        const links = extractRenderedNotionLinks(currentUrl, job.rootUrl);
        const title = String(document.title || '').replace(/\s*[|–—-]\s*Notion\s*$/i, '').trim();

        const visited = new Set(job.visited || []);
        const queued = new Set(
            (job.queue || []).map(item => notionCrawlerCurrentKey(item.url))
        );

        if (!visited.has(currentKey)) {
            visited.add(currentKey);
            job.pages = [...(job.pages || []), {
                url: currentUrl,
                title,
                text,
                depth: currentDepth,
                linkCount: links.length
            }];
        }

        if (currentDepth < NOTION_MAX_DEPTH) {
            for (const link of links) {
                if ((job.pages || []).length + (job.queue || []).length >= NOTION_MAX_PAGES) {
                    break;
                }

                const key = notionCrawlerCurrentKey(link.url);
                if (!key || visited.has(key) || queued.has(key)) continue;

                queued.add(key);
                job.queue = [...(job.queue || []), {
                    url: link.url,
                    title: link.title || '',
                    depth: currentDepth + 1
                }];
            }
        }

        job.visited = [...visited];
        job.lastPage = {
            url: currentUrl,
            title,
            depth: currentDepth,
            textLength: text.length,
            childLinks: links.length
        };

        const next = (job.queue || []).shift();

        if (next) {
            job.current = next;
            job.message =
                `Notion 실제 화면 수집 ${(job.pages || []).length}/${NOTION_MAX_PAGES}\n` +
                `${title || currentUrl}\n하위 링크 ${links.length}개 발견`;
            notionCrawlerJobWrite(job);

            await sleepMs(200);
            location.replace(next.url);
            return;
        }

        job.status = 'done';
        job.current = null;
        job.message =
            `Notion 실제 화면 수집 완료 · ${(job.pages || []).length}개 페이지`;
        notionCrawlerJobWrite(job);
        notionCrawlerBadge(job.message + '\n이 탭은 자동으로 닫힙니다.');

        await sleepMs(500);
        try { window.close(); } catch (_) {}
    }

    function buildRenderedNotionBatchPrompt(rootUrl, pages, settings = {}) {
        const pagePayload = pages.map((page, index) => `
===== PAGE ${index + 1} START =====
URL: ${page.url}
TITLE: ${page.title || ''}
DEPTH: ${page.depth}

${String(page.text || '').slice(0, 60000)}
===== PAGE ${index + 1} END =====`).join('\n');

        return `
너는 NovelAI 이미지 생성용 공유 Prompt "세트"를 원문 그대로 추출하는 분석기다.
아래 내용은 사용자의 브라우저가 실제로 렌더링한 공개 Notion 페이지들의 텍스트다.
루트 URL: ${rootUrl}

가장 중요한 규칙:
1. 창작하지 말고 추출만 하라.
2. Prompt에 있는 태그를 추가/삭제/번역/재정렬/교정/요약하지 마라.
3. 쉼표, # 접두사, :: 가중치, 괄호/중괄호/대괄호, 순서를 원문 그대로 보존하라.
4. 원문에 의미 있는 줄바꿈이 있으면 문자열 내부에서도 그대로 보존하라.
5. 하나의 완성된 세트 안에 "공통 Prompt / Character 1 Prompt / Character 2 Prompt"가 있으면 절대로 3개 concept로 쪼개지 마라. 하나의 concept 안에 합쳐 구조만 분리하라.
6. "공통 Prompt", "Base Prompt", "Common Prompt", "Scene Prompt" 등 전체에 적용되는 Prompt는 tags에 넣어라.
7. "Character 1 Prompt", "Character 2 Prompt", "Character N Prompt"처럼 캐릭터가 명시된 영역만 characters 배열로 옮겨라.
8. 단순 줄바꿈/문단 분리는 Character Prompt의 증거가 아니다. 캐릭터 라벨이 없으면 tags 안에 원문 줄바꿈 그대로 보존하라.
9. 전체 "Negative Prompt", "Undesired Content", "UC", "Negative"는 negativeTags에 넣어라.
10. "Character N Negative Prompt", "Character N Undesired Content"는 해당 character의 negativePrompt에 넣어라.
11. characters 항목의 name은 가능하면 원문의 "Character N" 라벨을 그대로 사용하라.
12. 공통 Prompt가 없고 Character Prompt만 있어도 concept 하나로 반환할 수 있다.
13. 페이지에 완전히 독립된 여러 프리셋/예시/세트가 명확히 있을 때만 concepts를 여러 개 반환하라.
14. 설명문, 목차, 사용법, 버튼명, 이미지 캡션, 해설 문장은 Prompt 태그에 넣지 마라.
15. 단, 해당 Prompt 세트 바로 위/아래 또는 같은 섹션에 작성자가 남긴 짧은 사용 팁/주의사항/추천 조합/수정 지시가 있으면 note에 보존하라.
16. note에는 PAGE에 실제 존재하는 문구만 사용하고 새 설명을 만들거나 추측하지 마라. 해당 세트와 무관한 잡담/긴 일반 설명은 제외하라.
17. 메모로 남길 내용이 없으면 note는 빈 문자열로 반환하라.
18. suggestedName은 실제 태그의 핵심 장면/용도/효과를 나타내는 짧고 구체적인 제목으로 만들어라.
19. suggestedName 앞에 "Nai 공유 태그 -", "NAI 공유 태그 -", "공유 태그 -", "Prompt -", "프롬프트 -", "태그 -" 같은 상투적인 접두어를 절대 붙이지 마라.
20. 페이지 제목을 기계적으로 복사하지 말고 태그 내용을 기준으로 "노트북 셀카", "피임 필수"처럼 간략하게 제안하라.
21. sourceUrl은 실제 태그가 나온 PAGE URL을 그대로 사용하라.
22. 태그가 없는 PAGE는 무시하라.
23. characters가 없으면 빈 배열 []로 반환하라.
24. JSON 하나만 출력하고 코드블록/설명은 금지한다.

반환 형식:
{
  "pageTitle": "전체 자료의 짧은 제목 또는 빈 문자열",
  "concepts": [
    {
      "suggestedName": "태그 내용을 나타내는 짧고 구체적인 제목",
      "sectionLabel": "원문의 세트/프리셋 라벨 또는 빈 문자열",
      "tags": "Base/Common/Positive Prompt. 없으면 빈 문자열",
      "negativeTags": "전체 Negative/Undesired Content. 없으면 빈 문자열",
      "characters": [
        {
          "name": "Character 1",
          "prompt": "해당 Character Prompt. 없으면 빈 문자열",
          "negativePrompt": "해당 Character Negative/Undesired Content. 없으면 빈 문자열"
        }
      ],
      "note": "해당 세트 주변의 작성자 사용 팁/주의사항 원문. 없으면 빈 문자열",
      "sourceUrl": "태그가 나온 PAGE URL",
      "sourcePageTitle": "해당 PAGE 제목"
    }
  ]
}


${pagePayload}
`.trim();
    }

    function parseRenderedNotionBatchJson(text, fallbackPages) {
        const parsed = parseLooseJsonObject(text);
        const rows = Array.isArray(parsed.concepts) ? parsed.concepts : [];
        const knownUrls = new Set(fallbackPages.map(page => page.url));

        return {
            pageTitle: String(parsed.pageTitle || '').trim(),
            concepts: rows.map((item, index) => {
                const tags = String(
                    item?.tags ??
                    item?.basePrompt ??
                    item?.prompt ??
                    item?.positivePrompt ??
                    ''
                ).trim();

                const negativeTags = String(
                    item?.negativeTags ??
                    item?.negativePrompt ??
                    item?.undesiredContent ??
                    ''
                ).trim();

                const characters = normalizeCharacterRows(
                    item?.characters ??
                    item?.characterPrompts ??
                    []
                );

                if (!tags && !negativeTags && !characters.length) {
                    return null;
                }

                let sourceUrl = String(item?.sourceUrl || '').trim();
                if (!knownUrls.has(sourceUrl)) {
                    sourceUrl = fallbackPages[0]?.url || '';
                }

                return {
                    id: createId(),
                    selected: true,
                    suggestedName:
                        String(item?.suggestedName || '').trim() ||
                        `컨셉 ${index + 1}`,
                    sectionLabel: String(
                        item?.sectionLabel ??
                        item?.setLabel ??
                        ''
                    ).trim(),
                    tags,
                    negativeTags,
                    characters,
                    note: String(item?.note || '').trim(),
                    sourceUrl,
                    sourcePageTitle: String(
                        item?.sourcePageTitle || ''
                    ).trim()
                };
            }).filter(Boolean)
        };
    }

    function splitRenderedNotionPagesIntoBatches(pages, maxChars = 115000) {
        const batches = [];
        let batch = [];
        let size = 0;

        for (const page of pages) {
            const text = String(page.text || '').trim();
            if (text.length < 20) continue;

            const estimated = Math.min(text.length, 60000) + 500;
            if (batch.length && size + estimated > maxChars) {
                batches.push(batch);
                batch = [];
                size = 0;
            }

            batch.push(page);
            size += estimated;
        }

        if (batch.length) batches.push(batch);
        return batches;
    }

    function openNotionCrawlerTab(url, jobId) {
        if (typeof GM_openInTab === 'function') {
            const tab = GM_openInTab(url, {
                active: false,
                insert: true,
                setParent: true
            });

            if (tab) {
                return {
                    kind: 'gm',
                    raw: tab,
                    isClosed() {
                        try {
                            return Boolean(tab.closed);
                        } catch (_) {
                            return false;
                        }
                    },
                    close() {
                        try {
                            if (typeof tab.close === 'function') tab.close();
                        } catch (_) {}
                    }
                };
            }
        }

        const win = PAGE_WINDOW.open(
            url,
            `nai-notion-crawler-${jobId}`
        );

        if (!win) return null;

        return {
            kind: 'window',
            raw: win,
            isClosed() {
                try {
                    return Boolean(win.closed);
                } catch (_) {
                    return false;
                }
            },
            close() {
                try { win.close(); } catch (_) {}
            }
        };
    }

    async function collectNotionRenderedPages(rootUrl, onStatus = () => {}) {
        const jobId = createId();
        const root = normalizeUrl(rootUrl);
        const job = {
            id: jobId,
            status: 'running',
            rootUrl: root,
            current: { url: root, title: '', depth: 0 },
            queue: [],
            visited: [],
            pages: [],
            message: 'Notion 실제 화면 탐색 탭 여는 중...',
            startedAt: Date.now(),
            updatedAt: Date.now()
        };

        notionCrawlerJobWrite(job);

        const helperTab = openNotionCrawlerTab(root, jobId);

        if (!helperTab) {
            notionCrawlerJobWrite({
                ...job,
                status: 'error',
                error: '브라우저가 Notion 탐색 탭을 차단했습니다. novelai.net의 팝업을 허용한 뒤 다시 시도해주세요.'
            });
            throw new Error(
                'Notion 탐색용 탭을 열 수 없습니다. novelai.net 팝업 허용 후 다시 시도해주세요.'
            );
        }

        const started = Date.now();
        let lastMessage = '';

        while (Date.now() - started < NOTION_BROWSER_MAX_WAIT_MS) {
            await sleepMs(600);

            const current = notionCrawlerJobRead();
            if (!current || current.id !== jobId) {
                throw new Error('Notion 탐색 작업 정보가 사라졌습니다.');
            }

            if (current.message && current.message !== lastMessage) {
                lastMessage = current.message;
                onStatus(current.message);
            }

            if (current.status === 'done') {
                GM_setValue(NOTION_BROWSER_JOB_KEY, null);
                return Array.isArray(current.pages) ? current.pages : [];
            }

            if (current.status === 'error') {
                GM_setValue(NOTION_BROWSER_JOB_KEY, null);
                throw new Error(current.error || 'Notion 실제 화면 탐색 실패');
            }

            let helperClosed = false;
            try {
                helperClosed = helperTab.isClosed();
            } catch (_) {}

            if (helperClosed) {
                throw new Error(
                    'Notion 탐색 탭이 완료 전에 닫혔습니다. 다시 시도해주세요.'
                );
            }
        }

        GM_setValue(NOTION_BROWSER_JOB_KEY, null);
        helperTab.close();
        throw new Error('Notion 탐색 시간이 초과되었습니다.');
    }

    async function analyzeNotionViaRenderedBrowser(
        url,
        settings,
        onStatus = () => {}
    ) {
        const rootUrl = normalizeUrl(url);
        const pages = await collectNotionRenderedPages(rootUrl, onStatus);

        if (!pages.length) {
            throw new Error('Notion 탭은 열렸지만 렌더링된 페이지 본문을 수집하지 못했습니다.');
        }

        onStatus(
            `Notion 실제 화면 ${pages.length}개 페이지 수집 완료\nAI 태그 분석 준비 중...`
        );

        const batches = splitRenderedNotionPagesIntoBatches(pages);
        if (!batches.length) {
            throw new Error(
                `Notion ${pages.length}개 페이지를 열었지만 분석할 본문 텍스트가 없습니다.`
            );
        }

        const concepts = [];
        const conceptKeys = new Set();
        let pageTitle = pages[0]?.title || 'Notion';
        let errors = 0;

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            onStatus(
                `Notion 본문 AI 분석 ${i + 1}/${batches.length}\n` +
                `${batch.length}개 페이지 처리 중...`
            );

            try {
                const response = await callProvider(
                    buildRenderedNotionBatchPrompt(rootUrl, batch, settings),
                    settings,
                    {
                        useUrlContext: false,
                        jsonMode: true
                    }
                );

                const parsed = parseRenderedNotionBatchJson(
                    response.text,
                    batch
                );

                if (parsed.pageTitle) pageTitle = parsed.pageTitle;

                for (const concept of parsed.concepts) {
                    const fingerprint = conceptFingerprint(concept.tags, concept.negativeTags, concept.characters);
                    if (!fingerprint || conceptKeys.has(fingerprint)) continue;
                    conceptKeys.add(fingerprint);
                    concepts.push(concept);
                }
            } catch (_) {
                errors += 1;
            }
        }

        if (!concepts.length) {
            const pageDiag = pages
                .slice(0, 8)
                .map(page => `${page.title || '제목없음'}(본문 ${page.text.length}, 링크 ${page.linkCount})`)
                .join(' / ');

            throw new Error(
                `Notion ${pages.length}개 실제 페이지를 열었지만 태그 묶음을 찾지 못했습니다.` +
                (pageDiag ? `\n수집 진단: ${pageDiag}` : '')
            );
        }

        return {
            pageTitle,
            concepts,
            method: 'notion-browser-crawl',
            pagesVisited: pages.length,
            assetsVisited: 0,
            errors
        };
    }

    async function analyzeSingleSharedUrl(url, settings, onStatus = () => {}) {
        const normalizedUrl = normalizeUrl(url);
        let firstError = null;

        try {
            onStatus('URL Context로 페이지 읽는 중...');

            const first = await callProvider(
                buildAnalyzePrompt(normalizedUrl, '', settings),
                settings,
                {
                    useUrlContext: true,
                    jsonMode: false
                }
            );

            if (urlContextClearlyFailed(first.urlStatus)) {
                throw new Error('AI가 URL Context로 페이지를 가져오지 못했습니다.');
            }

            const parsed = parseAnalysisJson(first.text);

            if (parsed.concepts.length) {
                return {
                    ...parsed,
                    method: 'url-context'
                };
            }

            throw new Error('URL Context 분석에서 태그 묶음을 찾지 못했습니다.');
        } catch (error) {
            firstError = error;
        }

        onStatus(
            'URL Context 분석이 충분하지 않아 원문 직접 가져오기 fallback 시도 중...'
        );

        try {
            const pageText = await fetchPublicPageText(normalizedUrl);

            onStatus('가져온 원문을 AI로 분석 중...');

            const second = await callProvider(
                buildAnalyzePrompt(normalizedUrl, pageText, settings),
                settings,
                {
                    useUrlContext: false,
                    jsonMode: true
                }
            );

            const parsed = parseAnalysisJson(second.text);

            if (!parsed.concepts.length) {
                throw new Error('페이지에서 태그 묶음을 찾지 못했습니다.');
            }

            return {
                ...parsed,
                method: 'direct-fetch'
            };
        } catch (fallbackError) {
            const prefix = firstError
                ? `URL Context: ${firstError.message}\n`
                : '';

            throw new Error(
                `${prefix}Fallback: ${fallbackError.message}`
            );
        }
    }

    async function analyzeSharedUrl(url, settings, onStatus = () => {}) {
        const normalizedUrl = normalizeUrl(url);

        if (isNotionUrl(normalizedUrl)) {
            onStatus('Notion 링크 감지 · 실제 렌더링 페이지 탐색 준비 중...');
            return analyzeNotionViaRenderedBrowser(
                normalizedUrl,
                settings,
                onStatus
            );
        }

        return analyzeSingleSharedUrl(
            normalizedUrl,
            settings,
            onStatus
        );
    }

    async function testProviderConnection(settings) {
        const result = await callProvider(
            'Reply with exactly: OK',
            settings,
            {
                useUrlContext: false,
                jsonMode: false
            }
        );

        if (!/\bOK\b/i.test(result.text)) {
            return `연결은 됐지만 예상 응답과 다릅니다: ${result.text.slice(0, 120)}`;
        }

        return '연결 성공: OK';
    }

    function validateSettings(settings) {
        if (settings.provider === 'gemini') {
            if (!String(settings.geminiKey || '').trim()) {
                return 'Gemini API Key가 비어 있습니다.';
            }

            return null;
        }

        if (settings.provider === 'vertex') {
            const parsed = parseServiceAccountJson(settings.vertexJson);

            if (!parsed.ok) return parsed.error;

            if (
                !String(settings.vertexProjectId || '').trim() &&
                !parsed.projectId
            ) {
                return 'Vertex project_id가 없습니다.';
            }

            return null;
        }

        if (settings.provider === 'firebase') {
            const config = parseFirebaseConfig(settings.firebaseConfig);

            if (!config?.apiKey || !config?.projectId) {
                return 'Firebase Config에서 apiKey/projectId를 찾지 못했습니다.';
            }

            return null;
        }

        return 'AI Provider를 선택해주세요.';
    }

    function findImageGenNavRow() {
        const currentRow = document.querySelector('.image-gen-nav-row');
        if (currentRow) return currentRow;

        const legacyNavbar = document.querySelector('.image-gen-navbar');
        return legacyNavbar?.firstElementChild || null;
    }

    function findImageGenMenuMount(row) {
        if (!row) return null;

        const menuButton = row.querySelector('button[aria-label="menu"]');

        if (menuButton) {
            const menuGroup = menuButton.parentElement;
            if (menuGroup && menuGroup !== row) {
                return {
                    parent: menuGroup,
                    before: menuButton,
                    menuButton,
                    mode: 'menu-group'
                };
            }

            return {
                parent: row,
                before: menuButton,
                menuButton,
                mode: 'row'
            };
        }

        const legacyMenuSlot = row.lastElementChild;
        if (!legacyMenuSlot) return null;

        return {
            parent: row,
            before: legacyMenuSlot,
            mode: 'legacy'
        };
    }

    function getNavbarMenuIconColor(menuButton) {
        if (!menuButton) return '';

        const icon = menuButton.querySelector('svg, [class]') || menuButton.firstElementChild;
        const candidates = [icon, menuButton].filter(Boolean);

        for (const element of candidates) {
            const style = getComputedStyle(element);
            const values = [
                style.backgroundColor,
                style.color,
                style.fill,
                style.stroke,
                style.webkitTextFillColor
            ];

            for (const value of values) {
                const color = String(value || '').trim();
                if (
                    color &&
                    color !== 'transparent' &&
                    color !== 'none' &&
                    color !== 'currentcolor' &&
                    !/^rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color)
                ) {
                    return color;
                }
            }
        }

        return '';
    }

    function syncNavbarDiamondColor(menuButton, archiveButton) {
        if (!menuButton || !archiveButton) return;
        const iconColor = getNavbarMenuIconColor(menuButton);
        if (iconColor) {
            archiveButton.style.setProperty('--nai-nav-diamond-color', iconColor);
        } else {
            archiveButton.style.removeProperty('--nai-nav-diamond-color');
        }
    }

    function syncNavbarButtonAppearance(menuButton, archiveButton) {
        if (!menuButton || !archiveButton) return;

        const diamondColor = archiveButton.style.getPropertyValue('--nai-nav-diamond-color');
        archiveButton.className = menuButton.className || '';
        archiveButton.style.cssText = menuButton.style.cssText || '';
        if (diamondColor) {
            archiveButton.style.setProperty('--nai-nav-diamond-color', diamondColor);
        }
        syncNavbarDiamondColor(menuButton, archiveButton);
        syncGlobalAnalyzeUi();
    }

    function watchNavbarButtonAppearance(menuButton, archiveButton) {
        if (!menuButton || !archiveButton) return;

        let syncFrame = null;
        const scheduleSync = () => {
            if (syncFrame) cancelAnimationFrame(syncFrame);
            syncFrame = requestAnimationFrame(() => {
                syncFrame = null;
                if (!menuButton.isConnected || !archiveButton.isConnected) {
                    appearanceObserver.disconnect();
                    rootObserver.disconnect();
                    bodyObserver?.disconnect();
                    return;
                }
                syncNavbarButtonAppearance(menuButton, archiveButton);
            });
        };

        const appearanceObserver = new MutationObserver(scheduleSync);
        appearanceObserver.observe(menuButton, {
            attributes: true,
            attributeFilter: ['class', 'style']
        });

        const rootObserver = new MutationObserver(scheduleSync);
        rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme']
        });

        const bodyObserver = document.body
            ? new MutationObserver(scheduleSync)
            : null;
        bodyObserver?.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme']
        });
    }

    function injectNavbarButton() {
        if (document.getElementById(BUTTON_ID)) return;

        const row = findImageGenNavRow();
        if (!row) return;

        const mount = findImageGenMenuMount(row);
        if (!mount?.parent || !mount?.before) return;

        const wrapper = document.createElement('div');
        wrapper.dataset.naiConceptLoaderSlot = 'true';
        wrapper.style.cssText =
            'flex:0 0 auto;min-width:0;display:flex;align-self:stretch;align-items:center;margin-right:6px;';

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.title = APP_NAME;
        button.setAttribute('aria-label', APP_NAME);
        button.innerHTML = '<span class="nai-nav-diamond" aria-hidden="true">✦</span>';
        button.addEventListener('click', openModal);

        if (mount.menuButton) {
            syncNavbarButtonAppearance(mount.menuButton, button);
        } else {
            button.classList.add('nai-nav-legacy');
        }

        wrapper.appendChild(button);
        mount.parent.insertBefore(wrapper, mount.before);

        if (mount.menuButton) {
            watchNavbarButtonAppearance(mount.menuButton, button);
        }
        syncGlobalAnalyzeUi();
    }

    function openModal() {
        acknowledgeAnalysisCompletion();
        if (document.getElementById(MODAL_ID)) return;

        let activeTab = 'library';
        let currentProvider = getSettings().provider || 'gemini';
        let editingId = null;
        let editingDraft = null;
        let resourceEditingId = null;
        let resourceEditingDraft = null;
        let visibleResourceIds = [];
        let resourceDragState = null;
        let resourceDragSuppressClickUntil = 0;
        let visibleLibraryIds = [];
        let libraryDragState = null;
        let libraryDragSuppressClickUntil = 0;
        let memoEditingId = null;
        let memoEditingDraft = null;
        let visibleMemoIds = [];
        let memoDragState = null;
        let memoDragSuppressClickUntil = 0;
        let libraryCreateOpen = false;
        let resourceCreateOpen = false;
        let memoCreateOpen = false;
        const resourceCreateCategories = new Set();
        const memoCreateCategories = new Set();
        let manualDraft = {
            name: '',
            note: '',
            sourceUrl: '',
            tags: '',
            negativeTags: '',
            characters: [],
            categories: []
        };
        let isTesting = false;
        const libraryNoteSaveTimers = new Map();
        const expandedLibraryCards = new Set();
        const expandedLibraryNotes = new Set();
        const activeLibraryCategories = new Set();
        let libraryCategoryEditMode = false;
        const activeResourceCategories = new Set();
        let resourceCategoryEditMode = false;
        const activeMemoCategories = new Set();
        let memoCategoryEditMode = false;
        let shareImportDraft = null;

        const backupItemSelection = {
            library: new Set(),
            resources: new Set(),
            memos: new Set()
        };
        let backupSelectionInitialized = false;
        let restoreDraft = null;

        function persistLibraryNote(id, value) {
            const library = getLibrary();
            const index = library.findIndex(item => item.id === id);
            if (index < 0) return;

            const current = normalizeConceptRecord(library[index]);
            library[index] = {
                ...current,
                note: String(value || '').trim(),
                updatedAt: Date.now()
            };
            saveLibrary(library);

            const timer = libraryNoteSaveTimers.get(id);
            if (timer) clearTimeout(timer);
            libraryNoteSaveTimers.delete(id);
        }

        function scheduleLibraryNoteSave(id, value) {
            const oldTimer = libraryNoteSaveTimers.get(id);
            if (oldTimer) clearTimeout(oldTimer);

            const timer = setTimeout(() => {
                persistLibraryNote(id, value);
            }, 650);
            libraryNoteSaveTimers.set(id, timer);
        }

        const overlay = document.createElement('div');
        overlay.id = MODAL_ID;
        overlay.className = 'nai-loader-overlay';

        overlay.innerHTML = `
            <div class="nai-loader-modal">
                <div class="nai-loader-header">
                    <div class="nai-loader-title"><span>${APP_NAME}</span><span class="nai-loader-version">v${APP_VERSION}</span></div>
                    <button
                        type="button"
                        class="nai-loader-close"
                        data-action="close"
                    >×</button>
                </div>

                <div class="nai-loader-tabs">
                    <button
                        type="button"
                        class="nai-loader-tab active"
                        data-tab="library"
                    >라이브러리</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="resources"
                    >자료실</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="memos"
                    >메모</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="import"
                    >가져오기</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="backup"
                    >백업/복원</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="settings"
                        aria-label="설정"
                        title="설정"
                    >⚙</button>
                </div>

                <div class="nai-loader-content">
                    <section
                        class="nai-loader-panel active"
                        data-panel="library"
                    >
                        <div class="nai-library-toolbar">
                            <input
                                id="nai-library-search"
                                class="nai-loader-input nai-loader-grow"
                                type="text"
                                placeholder="제목/태그/메모 등 검색"
                            >
                            <button
                                type="button"
                                class="nai-loader-action nai-toolbar-add-button"
                                data-create-toggle="library"
                                title="새 컨셉 추가"
                                aria-label="새 컨셉 추가"
                                aria-expanded="false"
                            >+</button>
                        </div>

                        <div
                            id="nai-library-category-bar"
                            class="nai-library-category-bar"
                            aria-label="라이브러리 분류 필터"
                        ></div>

                        <div id="nai-library-create-wrap" class="nai-inline-create-wrap" hidden>
                            <div id="nai-manual-editor-root"></div>
                            <div id="nai-manual-status" class="nai-loader-status"></div>
                        </div>

                        <div
                            id="nai-library-list"
                            class="nai-library-list"
                        ></div>

                        <div
                            id="nai-library-status"
                            class="nai-loader-status"
                        ></div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="resources"
                    >
                        <div class="nai-library-toolbar">
                            <input id="nai-resource-search" class="nai-loader-input nai-loader-grow" type="text" placeholder="자료 검색">
                            <button
                                type="button"
                                class="nai-loader-action nai-toolbar-add-button"
                                data-create-toggle="resources"
                                title="새 자료 추가"
                                aria-label="새 자료 추가"
                                aria-expanded="false"
                            >+</button>
                        </div>

                        <div
                            id="nai-resource-category-bar"
                            class="nai-library-category-bar"
                            aria-label="자료실 분류 필터"
                        ></div>

                        <div id="nai-resource-create-wrap" class="nai-inline-create-wrap" hidden>
                            <div class="nai-info-create-card">
                                <div class="nai-loader-field">
                                    <label class="nai-loader-label">이름</label>
                                    <input id="nai-resource-name" class="nai-loader-input" type="text" placeholder="예: 야외 조명 태그 모음">
                                </div>
                                <div class="nai-loader-field nai-library-edit-category-field">
                                    <label class="nai-loader-label">분류</label>
                                    <div id="nai-resource-create-categories" class="nai-library-card-category-row" aria-label="새 자료 분류"></div>
                                </div>
                                <div class="nai-loader-field">
                                    <label class="nai-loader-label">링크</label>
                                    <input id="nai-resource-url" class="nai-loader-input" type="url" placeholder="https://...">
                                </div>
                                <div class="nai-loader-field" style="margin-bottom:10px;">
                                    <label class="nai-loader-label">메모 <span class="nai-loader-muted">(선택)</span></label>
                                    <textarea id="nai-resource-note" class="nai-loader-textarea" placeholder="어떤 자료인지 / 어디를 보면 되는지"></textarea>
                                </div>
                                <div class="nai-edit-footer-actions">
                                    <button type="button" class="nai-loader-action" data-resource-action="cancel-add">취소</button>
                                    <button type="button" class="nai-loader-action primary" data-resource-action="add">자료 저장</button>
                                </div>
                            </div>
                        </div>

                        <div id="nai-resource-list" class="nai-info-list"></div>
                        <div id="nai-resource-status" class="nai-loader-status"></div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="memos"
                    >
                        <div class="nai-library-toolbar">
                            <input id="nai-memo-search" class="nai-loader-input nai-loader-grow" type="text" placeholder="메모 검색">
                            <button
                                type="button"
                                class="nai-loader-action nai-toolbar-add-button"
                                data-create-toggle="memos"
                                title="새 메모 추가"
                                aria-label="새 메모 추가"
                                aria-expanded="false"
                            >+</button>
                        </div>

                        <div
                            id="nai-memo-category-bar"
                            class="nai-library-category-bar"
                            aria-label="메모 분류 필터"
                        ></div>

                        <div id="nai-memo-create-wrap" class="nai-inline-create-wrap" hidden>
                            <div class="nai-info-create-card">
                                <div class="nai-loader-field">
                                    <label class="nai-loader-label">제목 <span class="nai-loader-muted">(선택)</span></label>
                                    <input id="nai-memo-title" class="nai-loader-input" type="text" placeholder="예: 인페 테스트">
                                </div>
                                <div class="nai-loader-field nai-library-edit-category-field">
                                    <label class="nai-loader-label">분류</label>
                                    <div id="nai-memo-create-categories" class="nai-library-card-category-row" aria-label="새 메모 분류"></div>
                                </div>
                                <div class="nai-loader-field" style="margin-bottom:10px;">
                                    <label class="nai-loader-label">내용</label>
                                    <textarea id="nai-memo-content" class="nai-loader-textarea" placeholder="기억할 내용을 적어두세요"></textarea>
                                </div>
                                <div class="nai-edit-footer-actions">
                                    <button type="button" class="nai-loader-action" data-memo-action="cancel-add">취소</button>
                                    <button type="button" class="nai-loader-action primary" data-memo-action="add">메모 저장</button>
                                </div>
                            </div>
                        </div>

                        <div id="nai-memo-list" class="nai-info-list"></div>
                        <div id="nai-memo-status" class="nai-loader-status"></div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="import"
                    >
                        <div class="nai-loader-field" style="margin-bottom:10px;">
                            <label class="nai-loader-label">URL 또는 공유 코드</label>
                            <input
                                id="nai-import-url"
                                class="nai-loader-input"
                                type="text"
                                placeholder="https://... 또는 NAICL1:..."
                            >
                        </div>

                        <div class="nai-loader-row nai-import-action-row">
                            <button
                                type="button"
                                class="nai-loader-action"
                                data-action="load-share-code"
                            >공유 코드 불러오기</button>

                            <button
                                type="button"
                                class="nai-loader-action primary"
                                data-action="analyze"
                            >URL 가져오기</button>
                        </div>

                        <div
                            id="nai-import-status"
                            class="nai-loader-status"
                        ></div>

                        <div
                            id="nai-share-import-preview"
                            class="nai-share-import-preview"
                            hidden
                        ></div>

                        <div
                            id="nai-analysis-wrap"
                            style="display:none;"
                        >
                            <div class="nai-loader-divider"></div>

                            <div class="nai-loader-row nai-analysis-header-row">
                                <div class="nai-loader-section-title nai-loader-grow"
                                     style="margin:0;">
                                    발견된 태그 묶음
                                </div>

                                <button
                                    type="button"
                                    class="nai-loader-action"
                                    data-action="select-all-results"
                                >
                                    전체 선택
                                </button>

                                <button
                                    type="button"
                                    class="nai-loader-action"
                                    data-action="clear-all-results"
                                >
                                    전체 해제
                                </button>

                                <button
                                    type="button"
                                    class="nai-loader-action primary"
                                    data-action="save-selected"
                                >
                                    선택 항목 저장
                                </button>
                            </div>

                            <div
                                id="nai-analysis-meta"
                                class="nai-loader-muted"
                                style="margin-top:8px;"
                            ></div>

                            <div
                                id="nai-ai-results"
                                class="nai-ai-results"
                            ></div>
                        </div>

                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="backup"
                    >
                        <div class="nai-loader-section-title">백업</div>
                        <div class="nai-backup-box">
                            <div class="nai-loader-muted">백업할 항목을 개별 선택해서 JSON 파일로 저장합니다. 선택한 항목에서 사용하는 분류만 함께 저장되며 API 키와 설정은 포함되지 않습니다.</div>
                            <div id="nai-backup-item-sections" class="nai-backup-section-list"></div>
                            <div class="nai-backup-actions">
                                <button type="button" class="nai-loader-action primary" data-action="create-backup-file">선택 항목 백업</button>
                            </div>
                        </div>

                        <div class="nai-loader-divider"></div>

                        <div class="nai-loader-section-title">복원</div>
                        <div class="nai-backup-box">
                            <div class="nai-loader-muted">기존 데이터는 유지하고 병합합니다. 완전히 같은 컨셉/링크/메모는 자동으로 제외합니다.</div>
                            <input id="nai-restore-file-input" type="file" accept="application/json,.json" hidden>
                            <div class="nai-backup-actions" style="justify-content:flex-start;">
                                <button type="button" class="nai-loader-action" data-action="pick-restore-file">백업 파일 선택</button>
                            </div>
                            <div id="nai-restore-preview" class="nai-restore-preview" hidden></div>
                        </div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="settings"
                    >
                        <div class="nai-loader-section-title">
                            AI Provider
                        </div>

                        <div class="nai-provider-buttons">
                            <button
                                type="button"
                                class="nai-provider-button"
                                data-provider="gemini"
                            >
                                Gemini API
                            </button>

                            <button
                                type="button"
                                class="nai-provider-button"
                                data-provider="vertex"
                            >
                                Vertex AI
                            </button>

                            <button
                                type="button"
                                class="nai-provider-button"
                                data-provider="firebase"
                            >
                                Firebase
                            </button>
                        </div>

                        <div
                            class="nai-provider-section"
                            data-provider-section="gemini"
                        >
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Gemini API Key
                                </label>

                                <input
                                    id="nai-settings-gemini-key"
                                    class="nai-loader-input"
                                    type="password"
                                    autocomplete="off"
                                    placeholder="API Key"
                                >
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">Model</label>

                                <select
                                    id="nai-settings-gemini-model"
                                    class="nai-loader-select"
                                >
                                    <option value="gemini-3.7-flash">Gemini 3.7 Flash — 권장 · 무료</option>
                                    <option value="gemini-3.6-flash">Gemini 3.6 Flash — 무료</option>
                                    <option value="gemini-3.5-flash">Gemini 3.5 Flash — 무료</option>
                                    <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview — 정밀 · 유료</option>
                                    <option value="gemini-2.5-flash">Gemini 2.5 Flash — 호환 · 무료</option>
                                </select>
                            </div>
                        </div>

                        <div
                            class="nai-provider-section"
                            data-provider-section="vertex"
                        >
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Service Account JSON
                                </label>

                                <textarea
                                    id="nai-settings-vertex-json"
                                    class="nai-loader-textarea"
                                    placeholder='{"type":"service_account", ...}'
                                ></textarea>
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Project ID
                                </label>

                                <input
                                    id="nai-settings-vertex-project"
                                    class="nai-loader-input"
                                    type="text"
                                    placeholder="비워두면 JSON의 project_id 사용"
                                >
                            </div>

                            <div class="nai-loader-row">
                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Location
                                    </label>

                                    <input
                                        id="nai-settings-vertex-location"
                                        class="nai-loader-input"
                                        type="text"
                                        placeholder="global"
                                    >
                                </div>

                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Model
                                    </label>

                                    <select
                                        id="nai-settings-vertex-model"
                                        class="nai-loader-select"
                                    >
                                        <option value="gemini-3.7-flash">Gemini 3.7 Flash — 권장</option>
                                        <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                                        <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview — 정밀</option>
                                        <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                                        <option value="gemini-2.5-flash">Gemini 2.5 Flash — 호환</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div
                            class="nai-provider-section"
                            data-provider-section="firebase"
                        >
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Firebase Config
                                </label>

                                <textarea
                                    id="nai-settings-firebase-config"
                                    class="nai-loader-textarea"
                                    placeholder='firebaseConfig = {
    apiKey: "...",
    projectId: "...",
    ...
}'
                                ></textarea>
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Firebase AI Backend
                                </label>

                                <select
                                    id="nai-settings-firebase-backend"
                                    class="nai-loader-select"
                                >
                                    <option value="vertex">
                                        Vertex AI backend
                                    </option>
                                    <option value="googleai">
                                        Gemini Developer API backend
                                    </option>
                                </select>
                            </div>

                            <div class="nai-loader-row">
                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Location
                                    </label>

                                    <input
                                        id="nai-settings-firebase-location"
                                        class="nai-loader-input"
                                        type="text"
                                        placeholder="global"
                                    >
                                </div>

                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Model
                                    </label>

                                    <select
                                        id="nai-settings-firebase-model"
                                        class="nai-loader-select"
                                    >
                                        <option value="gemini-3.7-flash">Gemini 3.7 Flash — 권장</option>
                                        <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                                        <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview — 정밀</option>
                                        <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                                        <option value="gemini-2.5-flash">Gemini 2.5 Flash — 호환</option>
                                    </select>
                                </div>
                            </div>
                        </div>


                        <div class="nai-loader-row nai-settings-action-row">
                            <button
                                type="button"
                                class="nai-loader-action"
                                data-action="test-settings"
                            >
                                연결 테스트
                            </button>

                            <button
                                type="button"
                                class="nai-loader-action primary"
                                data-action="save-settings"
                            >
                                설정 저장
                            </button>
                        </div>

                        <div
                            id="nai-settings-status"
                            class="nai-loader-status"
                        ></div>

                        <div class="nai-loader-divider"></div>

                        <div class="nai-loader-row" style="justify-content:flex-start;">
                            <button
                                type="button"
                                class="nai-loader-action danger"
                                data-action="reset-archive"
                            >
                                전체 초기화
                            </button>
                        </div>

                        <div class="nai-loader-divider"></div>

                        <div class="nai-loader-muted">
                            기본 권장 모델은 ${DEFAULT_MODEL}. 모델은 위 드롭다운의 지원 목록에서 선택합니다.<br>
                            인증정보는 이 유저스크립트의 GM 저장소에 저장되며
                            GitHub 코드에 자동으로 포함되지 않습니다.
                        </div>
                    </section>
                </div>
            </div>
            <div
                id="nai-loader-toast"
                class="nai-loader-toast"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            ></div>
        `;

        document.body.appendChild(overlay);

        const $ = selector => overlay.querySelector(selector);
        const $$ = selector => [...overlay.querySelectorAll(selector)];

        let toastHideTimer = null;
        let toastSerial = 0;

        function transientStatusTone(message) {
            const value = String(message || '');
            return /(실패|오류|못했습니다|찾지 못|입력해주세요|사용할 수 없습니다|이미 있습니다|중단|올바른|http\/https)/i.test(value)
                ? 'error'
                : 'info';
        }

        function showToast(message, tone = 'info') {
            const toast = $('#nai-loader-toast');
            const value = String(message || '').trim();
            if (!toast || !value) return;

            if (toastHideTimer) clearTimeout(toastHideTimer);
            const serial = ++toastSerial;

            toast.textContent = value;
            toast.classList.toggle('error', tone === 'error');
            toast.classList.remove('show');

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (serial !== toastSerial || !toast.isConnected) return;
                    toast.classList.add('show');
                });
            });

            const duration = tone === 'error' ? 3600 : 2300;
            toastHideTimer = setTimeout(() => {
                if (serial !== toastSerial || !toast.isConnected) return;
                toast.classList.remove('show');
            }, duration);
        }

        function bridgeTransientStatusToToast(status) {
            if (!status) return;
            const flush = () => {
                const message = String(status.textContent || '').trim();
                if (!message) return;
                showToast(message, transientStatusTone(message));
            };
            const observer = new MutationObserver(flush);
            observer.observe(status, {
                childList: true,
                characterData: true,
                subtree: true
            });
            flush();
        }

        [
            '#nai-manual-status',
            '#nai-library-status',
            '#nai-resource-status',
            '#nai-memo-status'
        ].forEach(selector => bridgeTransientStatusToToast($(selector)));

        function providerLabel(provider) {
            if (provider === 'gemini') return 'Gemini API';
            if (provider === 'vertex') return 'Vertex AI';
            if (provider === 'firebase') return 'Firebase';
            return provider;
        }

        function switchTab(tab) {
            if (activeTab === 'library' && libraryCreateOpen && tab !== 'library') {
                syncManualDraftFromDom();
            }

            activeTab = tab;

            $$('.nai-loader-tab').forEach(button => {
                button.classList.toggle(
                    'active',
                    button.dataset.tab === tab
                );
            });

            $$('.nai-loader-panel').forEach(panel => {
                panel.classList.toggle(
                    'active',
                    panel.dataset.panel === tab
                );
            });

            if (tab === 'library') {
                renderLibrary();
            }

            if (tab === 'resources') {
                renderResources();
            }

            if (tab === 'memos') {
                renderMemos();
            }

            if (tab === 'import') {
                renderShareImportPreview();
            }

            if (tab === 'backup') {
                renderBackupSelection();
                renderRestorePreview();
            }
        }

        function backupKindItems(kind) {
            if (kind === 'library') return getLibrary();
            if (kind === 'resources') return getResources();
            if (kind === 'memos') return getMemos();
            return [];
        }

        function backupItemLabel(kind, item) {
            if (kind === 'library') {
                return String(item?.name || item?.suggestedName || '이름 없는 컨셉').trim() || '이름 없는 컨셉';
            }
            if (kind === 'resources') {
                return String(item?.name || item?.url || '이름 없는 자료').trim() || '이름 없는 자료';
            }
            if (kind === 'memos') {
                const title = String(item?.title || '').trim();
                if (title) return title;
                const preview = String(item?.content || '').trim().replace(/\s+/g, ' ').slice(0, 42);
                return preview || '내용 없는 메모';
            }
            return '항목';
        }

        function ensureBackupSelectionInitialized() {
            const kinds = ['library', 'resources', 'memos'];
            if (!backupSelectionInitialized) {
                for (const kind of kinds) {
                    backupItemSelection[kind] = new Set(
                        backupKindItems(kind).map(item => String(item?.id || '')).filter(Boolean)
                    );
                }
                backupSelectionInitialized = true;
                return;
            }

            for (const kind of kinds) {
                const validIds = new Set(
                    backupKindItems(kind).map(item => String(item?.id || '')).filter(Boolean)
                );
                for (const id of [...backupItemSelection[kind]]) {
                    if (!validIds.has(id)) backupItemSelection[kind].delete(id);
                }
            }
        }

        function renderBackupSelection() {
            const root = $('#nai-backup-item-sections');
            if (!root) return;
            ensureBackupSelectionInitialized();

            root.innerHTML = ['library', 'resources', 'memos'].map(kind => {
                const items = backupKindItems(kind);
                const selected = backupItemSelection[kind];
                const rows = items.length
                    ? items.map(item => {
                        const id = String(item?.id || '');
                        const checked = selected.has(id);
                        return `
                            <label class="nai-backup-item" title="${escapeHtml(backupItemLabel(kind, item))}">
                                <input
                                    type="checkbox"
                                    data-backup-item-kind="${kind}"
                                    data-backup-item-id="${escapeHtml(id)}"
                                    ${checked ? 'checked' : ''}
                                >
                                <span class="nai-backup-item-label">${escapeHtml(backupItemLabel(kind, item))}</span>
                            </label>
                        `;
                    }).join('')
                    : '<div class="nai-backup-empty">저장된 항목이 없습니다.</div>';

                return `
                    <div class="nai-backup-section" data-backup-section="${kind}">
                        <div class="nai-backup-section-head">
                            <span class="nai-backup-section-title">${restoreKindLabel(kind)}</span>
                            <span class="nai-backup-section-count">${selected.size}/${items.length}</span>
                            <div class="nai-backup-section-controls">
                                <button type="button" class="nai-loader-action" data-backup-select-all="${kind}">전체 선택</button>
                                <button type="button" class="nai-loader-action" data-backup-clear-all="${kind}">전체 해제</button>
                            </div>
                        </div>
                        <div class="nai-backup-item-list">${rows}</div>
                    </div>
                `;
            }).join('');
        }

        function backupSelectedCount() {
            return ['library', 'resources', 'memos']
                .reduce((sum, kind) => sum + backupItemSelection[kind].size, 0);
        }

        function downloadBackupFile() {
            ensureBackupSelectionInitialized();
            const selectedCount = backupSelectedCount();
            if (!selectedCount) {
                showToast('백업할 항목을 하나 이상 선택해주세요.', 'error');
                return;
            }

            const payload = createArchiveBackupPayload(backupItemSelection);
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
            link.href = objectUrl;
            link.download = `NAI-Archive-backup-${stamp}.json`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
            showToast(`선택한 ${selectedCount}개 항목을 백업했습니다.`);
        }

        function restoreKindLabel(kind) {
            if (kind === 'library') return '라이브러리';
            if (kind === 'resources') return '자료실';
            if (kind === 'memos') return '메모';
            return kind;
        }

        function renderRestorePreview() {
            const preview = $('#nai-restore-preview');
            if (!preview) return;

            if (!restoreDraft?.backup) {
                preview.hidden = true;
                preview.innerHTML = '';
                return;
            }

            const inspection = inspectArchiveRestore(restoreDraft.backup);
            const availableKinds = ['library', 'resources', 'memos'].filter(
                kind => !!restoreDraft.backup.sections?.[kind]
            );
            const summaryRows = availableKinds.map(kind => {
                const stat = inspection[kind] || { total: 0, duplicate: 0, addable: 0, invalid: 0 };
                const extras = [];
                if (stat.duplicate) extras.push(`중복 ${stat.duplicate}개 제외`);
                if (stat.invalid) extras.push(`유효하지 않음 ${stat.invalid}개 제외`);
                return `<div><strong>${restoreKindLabel(kind)}</strong> ${stat.total}개 · 복원 예정 ${stat.addable}개${extras.length ? ` · ${extras.join(' · ')}` : ''}</div>`;
            }).join('');

            preview.hidden = false;
            preview.innerHTML = `
                <div class="nai-restore-file-name">${escapeHtml(restoreDraft.fileName || '백업 파일')}</div>
                <div class="nai-loader-muted">복원할 항목을 선택하세요.</div>
                <div class="nai-backup-choice-row">
                    ${availableKinds.map(kind => `
                        <button
                            type="button"
                            class="nai-library-category-chip nai-backup-choice${restoreDraft.selected.has(kind) ? ' active' : ''}"
                            data-restore-kind="${kind}"
                        >${restoreKindLabel(kind)}</button>
                    `).join('')}
                </div>
                <div class="nai-restore-summary">${summaryRows}</div>
                <div class="nai-edit-footer-actions" style="margin-top:12px;">
                    <button type="button" class="nai-loader-action" data-action="cancel-restore-preview">취소</button>
                    <button type="button" class="nai-loader-action primary" data-action="run-restore">복원 실행</button>
                </div>
            `;
        }

        async function loadRestoreFile(file) {
            if (!file) return;
            try {
                const rawText = await file.text();
                const backup = parseArchiveBackupPayload(rawText);
                const availableKinds = ['library', 'resources', 'memos'].filter(
                    kind => !!backup.sections?.[kind]
                );
                restoreDraft = {
                    fileName: file.name || '백업 파일',
                    backup,
                    selected: new Set(availableKinds)
                };
                renderRestorePreview();
            } catch (error) {
                restoreDraft = null;
                renderRestorePreview();
                showToast(`백업 파일 읽기 실패: ${error?.message || String(error)}`, 'error');
            } finally {
                const input = $('#nai-restore-file-input');
                if (input) input.value = '';
            }
        }

        function runRestore() {
            if (!restoreDraft?.backup) {
                showToast('먼저 백업 파일을 선택해주세요.', 'error');
                return;
            }
            if (!restoreDraft.selected.size) {
                showToast('복원할 항목을 하나 이상 선택해주세요.', 'error');
                return;
            }

            const result = restoreArchiveBackup(restoreDraft.backup, [...restoreDraft.selected]);
            const parts = [];
            for (const kind of ['library', 'resources', 'memos']) {
                if (!restoreDraft.selected.has(kind) || !restoreDraft.backup.sections?.[kind]) continue;
                const item = result[kind];
                const skipped = item.duplicate + item.invalid;
                parts.push(`${restoreKindLabel(kind)} ${item.added}개${skipped ? ` (제외 ${skipped}개)` : ''}`);
            }

            restoreDraft = null;
            renderRestorePreview();
            renderLibrary();
            renderResources();
            renderMemos();
            showToast(`복원 완료 · ${parts.join(' / ')}`);
        }

        function updateProviderUI() {
            $('#nai-backup-item-sections')?.addEventListener('change', event => {
                const input = event.target.closest('input[data-backup-item-kind][data-backup-item-id]');
                if (!input) return;
                const kind = input.dataset.backupItemKind;
                const id = input.dataset.backupItemId;
                if (!backupItemSelection[kind] || !id) return;
                if (input.checked) backupItemSelection[kind].add(id);
                else backupItemSelection[kind].delete(id);
                renderBackupSelection();
            });

            $('#nai-backup-item-sections')?.addEventListener('click', event => {
                const selectAll = event.target.closest('[data-backup-select-all]');
                if (selectAll) {
                    const kind = selectAll.dataset.backupSelectAll;
                    backupItemSelection[kind] = new Set(
                        backupKindItems(kind).map(item => String(item?.id || '')).filter(Boolean)
                    );
                    renderBackupSelection();
                    return;
                }

                const clearAll = event.target.closest('[data-backup-clear-all]');
                if (clearAll) {
                    const kind = clearAll.dataset.backupClearAll;
                    backupItemSelection[kind]?.clear();
                    renderBackupSelection();
                }
            });

        $('[data-action="create-backup-file"]')?.addEventListener('click', downloadBackupFile);

        $('[data-action="pick-restore-file"]')?.addEventListener('click', () => {
            $('#nai-restore-file-input')?.click();
        });

        $('#nai-restore-file-input')?.addEventListener('change', event => {
            loadRestoreFile(event.target.files?.[0] || null);
        });

        $('#nai-restore-preview')?.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;

            if (button.matches('[data-restore-kind]')) {
                const kind = button.dataset.restoreKind;
                if (!restoreDraft?.selected) return;
                if (restoreDraft.selected.has(kind)) restoreDraft.selected.delete(kind);
                else restoreDraft.selected.add(kind);
                renderRestorePreview();
                return;
            }

            if (button.dataset.action === 'cancel-restore-preview') {
                restoreDraft = null;
                renderRestorePreview();
                return;
            }

            if (button.dataset.action === 'run-restore') {
                runRestore();
            }
        });

        $$('.nai-provider-button').forEach(button => {
                button.classList.toggle(
                    'active',
                    button.dataset.provider === currentProvider
                );
            });

            $$('.nai-provider-section').forEach(section => {
                section.classList.toggle(
                    'active',
                    section.dataset.providerSection === currentProvider
                );
            });
        }

        const MODEL_PRESETS = new Set([
            'gemini-3.7-flash',
            'gemini-3.6-flash',
            'gemini-3.1-pro-preview',
            'gemini-3.5-flash',
            'gemini-2.5-flash'
        ]);

        function loadModelPicker(selectSelector, value) {
            const model = String(value || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
            const select = $(selectSelector);
            select.value = MODEL_PRESETS.has(model) ? model : DEFAULT_MODEL;
        }

        function readModelPicker(selectSelector) {
            return $(selectSelector).value || DEFAULT_MODEL;
        }

        function loadSettingsIntoForm() {
            const settings = getSettings();

            currentProvider = settings.provider || 'gemini';

            $('#nai-settings-gemini-key').value =
                settings.geminiKey || '';

            loadModelPicker(
                '#nai-settings-gemini-model',
                settings.geminiModel
            );

            $('#nai-settings-vertex-json').value =
                settings.vertexJson || '';

            $('#nai-settings-vertex-project').value =
                settings.vertexProjectId || '';

            $('#nai-settings-vertex-location').value =
                settings.vertexLocation || 'global';

            loadModelPicker(
                '#nai-settings-vertex-model',
                settings.vertexModel
            );

            $('#nai-settings-firebase-config').value =
                settings.firebaseConfig || '';

            $('#nai-settings-firebase-backend').value =
                settings.firebaseBackend || 'vertex';

            $('#nai-settings-firebase-location').value =
                settings.firebaseLocation || 'global';

            loadModelPicker(
                '#nai-settings-firebase-model',
                settings.firebaseModel
            );

            updateProviderUI();
        }

        function collectSettingsFromForm() {
            return {
                provider: currentProvider,

                geminiKey:
                    $('#nai-settings-gemini-key').value.trim(),

                geminiModel: readModelPicker(
                    '#nai-settings-gemini-model'
                ),

                vertexJson:
                    $('#nai-settings-vertex-json').value.trim(),

                vertexProjectId:
                    $('#nai-settings-vertex-project').value.trim(),

                vertexLocation:
                    $('#nai-settings-vertex-location').value.trim() ||
                    'global',

                vertexModel: readModelPicker(
                    '#nai-settings-vertex-model'
                ),

                firebaseConfig:
                    $('#nai-settings-firebase-config').value.trim(),

                firebaseBackend:
                    $('#nai-settings-firebase-backend').value ||
                    'vertex',

                firebaseLocation:
                    $('#nai-settings-firebase-location').value.trim() ||
                    'global',

                firebaseModel: readModelPicker(
                    '#nai-settings-firebase-model'
                )
            };
        }

        function setCreatePanelOpen(kind, open) {
            const nextOpen = !!open;
            let wrap = null;
            let toggle = null;

            if (kind === 'library') {
                libraryCreateOpen = nextOpen;
                wrap = $('#nai-library-create-wrap');
                toggle = $('[data-create-toggle="library"]');
                if (nextOpen) renderManualAddEditor();
            } else if (kind === 'resources') {
                resourceCreateOpen = nextOpen;
                wrap = $('#nai-resource-create-wrap');
                toggle = $('[data-create-toggle="resources"]');
                if (nextOpen) renderResourceCreateCategoryAssignment();
            } else if (kind === 'memos') {
                memoCreateOpen = nextOpen;
                wrap = $('#nai-memo-create-wrap');
                toggle = $('[data-create-toggle="memos"]');
                if (nextOpen) renderMemoCreateCategoryAssignment();
            }

            if (wrap) wrap.hidden = !nextOpen;
            if (toggle) {
                toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                toggle.classList.toggle('primary', nextOpen);
            }
        }

        function clearResourceCreateForm() {
            if ($('#nai-resource-name')) $('#nai-resource-name').value = '';
            if ($('#nai-resource-url')) $('#nai-resource-url').value = '';
            if ($('#nai-resource-note')) $('#nai-resource-note').value = '';
            resourceCreateCategories.clear();
            renderResourceCreateCategoryAssignment();
        }

        function clearMemoCreateForm() {
            if ($('#nai-memo-title')) $('#nai-memo-title').value = '';
            if ($('#nai-memo-content')) $('#nai-memo-content').value = '';
            memoCreateCategories.clear();
            renderMemoCreateCategoryAssignment();
        }

        function getInfoCategoryConfig(kind) {
            if (kind === 'resources') {
                return {
                    kind,
                    label: '자료실',
                    bar: '#nai-resource-category-bar',
                    status: '#nai-resource-status',
                    getCategories: getResourceCategories,
                    saveCategories: saveResourceCategories,
                    getItems: getResources,
                    saveItems: saveResources,
                    normalizeItem: normalizeResourceRecord,
                    active: activeResourceCategories,
                    getEditMode: () => resourceCategoryEditMode,
                    setEditMode: value => { resourceCategoryEditMode = !!value; },
                    getEditingDraft: () => resourceEditingDraft,
                    setEditingDraft: value => { resourceEditingDraft = value; },
                    render: renderResources
                };
            }

            return {
                kind: 'memos',
                label: '메모',
                bar: '#nai-memo-category-bar',
                status: '#nai-memo-status',
                getCategories: getMemoCategories,
                saveCategories: saveMemoCategories,
                getItems: getMemos,
                saveItems: saveMemos,
                normalizeItem: normalizeMemoRecord,
                active: activeMemoCategories,
                getEditMode: () => memoCategoryEditMode,
                setEditMode: value => { memoCategoryEditMode = !!value; },
                getEditingDraft: () => memoEditingDraft,
                setEditingDraft: value => { memoEditingDraft = value; },
                render: renderMemos
            };
        }

        function renderInfoCategoryBar(kind) {
            const config = getInfoCategoryConfig(kind);
            const bar = $(config.bar);
            if (!bar) return;

            const categories = config.getCategories();
            const valid = new Set(categories);
            [...config.active].forEach(name => {
                if (!valid.has(name)) config.active.delete(name);
            });

            const filters = [
                `<button type="button" class="nai-library-category-chip${config.active.size ? '' : ' active'}" data-info-category-filter="__all__" data-info-category-scope="${config.kind}">전체</button>`
            ];

            categories.forEach(name => {
                filters.push(
                    `<button type="button" class="nai-library-category-chip${config.active.has(name) ? ' active' : ''}" data-info-category-filter="${escapeHtml(name)}" data-info-category-scope="${config.kind}">${escapeHtml(name)}</button>`
                );
            });

            const editMode = config.getEditMode();
            const manager = editMode ? `
                <div class="nai-library-category-manager" data-info-category-manager="${config.kind}">
                    ${categories.length ? categories.map((name, index) => `
                        <div class="nai-library-category-manager-row" data-info-category-manager-row="${escapeHtml(name)}">
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-info-category-move="up"
                                data-info-category-name="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                                title="위로 이동"
                                ${index === 0 ? 'disabled' : ''}
                            >↑</button>
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-info-category-move="down"
                                data-info-category-name="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                                title="아래로 이동"
                                ${index === categories.length - 1 ? 'disabled' : ''}
                            >↓</button>
                            <input
                                type="text"
                                class="nai-loader-input nai-loader-grow"
                                value="${escapeHtml(name)}"
                                data-info-category-rename="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                                aria-label="${escapeHtml(name)} 분류 이름"
                            >
                            <button
                                type="button"
                                class="nai-library-category-manager-button danger"
                                data-info-category-delete="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                            >삭제</button>
                        </div>
                    `).join('') : '<div class="nai-library-category-empty">아직 만든 분류가 없습니다.</div>'}
                </div>
            ` : '';

            bar.innerHTML = `
                <div class="nai-library-category-filter-group">
                    ${filters.join('')}
                </div>
                <div class="nai-library-category-tools">
                    <button
                        type="button"
                        class="nai-library-category-chip nai-library-category-edit-button${editMode ? ' active' : ''}"
                        data-info-category-edit-toggle
                        data-info-category-scope="${config.kind}"
                        aria-expanded="${editMode ? 'true' : 'false'}"
                    >${editMode ? '완료' : '수정'}</button>
                    <button
                        type="button"
                        class="nai-library-category-chip nai-category-add"
                        data-info-category-add
                        data-info-category-scope="${config.kind}"
                        title="새 분류 추가"
                        aria-label="새 분류 추가"
                    >+</button>
                </div>
                ${manager}
            `;
        }

        function renderInfoCategoryAssignment(kind, item) {
            const config = getInfoCategoryConfig(kind);
            const categories = config.getCategories();
            if (!categories.length) return '';

            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-info-category-assign="${escapeHtml(name)}"
                    data-info-category-scope="${config.kind}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderResourceSelectedCategoryBadges(item) {
            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            if (!selected.size) return '';
            const categories = getResourceCategories();
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...[...selected].filter(name => !categories.includes(name))
            ];
            return ordered.map(name =>
                `<span class="nai-resource-category-badge">${escapeHtml(name)}</span>`
            ).join('');
        }

        function renderResourceCreateCategoryAssignment() {
            const row = $('#nai-resource-create-categories');
            if (!row) return;

            const categories = getResourceCategories();
            const valid = new Set(categories);
            [...resourceCreateCategories].forEach(name => {
                if (!valid.has(name)) resourceCreateCategories.delete(name);
            });

            if (!categories.length) {
                row.innerHTML = '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
                return;
            }

            const ordered = [
                ...categories.filter(name => resourceCreateCategories.has(name)),
                ...categories.filter(name => !resourceCreateCategories.has(name))
            ];

            row.innerHTML = ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${resourceCreateCategories.has(name) ? ' active' : ''}"
                    data-resource-create-category="${escapeHtml(name)}"
                    aria-pressed="${resourceCreateCategories.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderManualCreateCategoryAssignmentHtml() {
            const categories = getLibraryCategories();
            const selected = new Set(normalizeLibraryCategoryList(manualDraft?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];
            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-manual-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderManualCreateCategoryAssignment() {
            const row = $('#nai-manual-create-categories');
            if (!row) return;

            const categories = getLibraryCategories();
            const selected = new Set(normalizeLibraryCategoryList(manualDraft?.categories));
            const valid = new Set(categories);
            [...selected].forEach(name => {
                if (!valid.has(name)) selected.delete(name);
            });
            manualDraft.categories = normalizeLibraryCategoryList([...selected]);

            if (!categories.length) {
                row.innerHTML = '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
                return;
            }

            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            row.innerHTML = ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-manual-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderMemoCreateCategoryAssignment() {
            const row = $('#nai-memo-create-categories');
            if (!row) return;

            const categories = getMemoCategories();
            const valid = new Set(categories);
            [...memoCreateCategories].forEach(name => {
                if (!valid.has(name)) memoCreateCategories.delete(name);
            });

            if (!categories.length) {
                row.innerHTML = '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
                return;
            }

            const ordered = [
                ...categories.filter(name => memoCreateCategories.has(name)),
                ...categories.filter(name => !memoCreateCategories.has(name))
            ];

            row.innerHTML = ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${memoCreateCategories.has(name) ? ' active' : ''}"
                    data-memo-create-category="${escapeHtml(name)}"
                    aria-pressed="${memoCreateCategories.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderMemoSelectedCategoryBadges(item) {
            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            if (!selected.size) return '';
            const categories = getMemoCategories();
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...[...selected].filter(name => !categories.includes(name))
            ];
            return ordered.map(name =>
                `<span class="nai-memo-category-badge">${escapeHtml(name)}</span>`
            ).join('');
        }

        function saveVisibleMemoOrder(orderedVisibleIds) {
            const memos = getMemos();
            if (!memos.length) return false;

            const byId = new Map(memos.map(item => [item.id, item]));
            const visibleSet = new Set(
                visibleMemoIds.filter(id => byId.has(id))
            );
            if (visibleSet.size < 2) return false;

            const nextVisibleOrder = [];
            orderedVisibleIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });
            visibleMemoIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });

            let cursor = 0;
            const reordered = memos.map(item => {
                if (!visibleSet.has(item.id)) return item;
                const nextId = nextVisibleOrder[cursor++];
                return byId.get(nextId) || item;
            });

            saveMemos(reordered);
            return true;
        }

        function saveVisibleResourceOrder(orderedVisibleIds) {
            const resources = getResources();
            if (!resources.length) return false;

            const byId = new Map(resources.map(item => [item.id, item]));
            const visibleSet = new Set(
                visibleResourceIds.filter(id => byId.has(id))
            );
            if (visibleSet.size < 2) return false;

            const nextVisibleOrder = [];
            orderedVisibleIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });
            visibleResourceIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });

            let cursor = 0;
            const reordered = resources.map(item => {
                if (!visibleSet.has(item.id)) return item;
                const nextId = nextVisibleOrder[cursor++];
                return byId.get(nextId) || item;
            });

            saveResources(reordered);
            return true;
        }

        function renameInfoCategory(kind, oldName, rawNewName) {
            const config = getInfoCategoryConfig(kind);
            const previous = normalizeLibraryCategoryName(oldName);
            const next = normalizeLibraryCategoryName(rawNewName);
            if (!previous) return false;

            if (!next || next === '전체' || next === '+') {
                $(config.status).textContent = '이 이름은 분류로 사용할 수 없습니다.';
                config.render();
                return false;
            }
            if (previous === next) return true;

            const categories = config.getCategories();
            if (categories.includes(next)) {
                $(config.status).textContent = `"${next}" 분류는 이미 있습니다.`;
                config.render();
                return false;
            }

            const categoryIndex = categories.indexOf(previous);
            if (categoryIndex < 0) return false;
            categories[categoryIndex] = next;
            config.saveCategories(categories);

            const items = config.getItems().map(rawItem => {
                const item = config.normalizeItem(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).map(name => name === previous ? next : name)
                    )
                };
            });
            config.saveItems(items);

            if (config.active.delete(previous)) config.active.add(next);

            const draft = config.getEditingDraft();
            if (draft?.categories) {
                config.setEditingDraft({
                    ...draft,
                    categories: normalizeLibraryCategoryList(
                        draft.categories.map(name => name === previous ? next : name)
                    )
                });
            }

            $(config.status).textContent = `"${previous}" → "${next}"로 변경했습니다.`;
            config.render();
            return true;
        }

        function deleteInfoCategory(kind, name) {
            const config = getInfoCategoryConfig(kind);
            const target = normalizeLibraryCategoryName(name);
            if (!target) return;
            if (!window.confirm(`"${target}" 분류를 삭제할까요?\n${config.label} 항목에 지정된 이 분류도 함께 제거됩니다.`)) return;

            config.saveCategories(
                config.getCategories().filter(category => category !== target)
            );

            const items = config.getItems().map(rawItem => {
                const item = config.normalizeItem(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).filter(category => category !== target)
                    )
                };
            });
            config.saveItems(items);
            config.active.delete(target);

            const draft = config.getEditingDraft();
            if (draft?.categories) {
                config.setEditingDraft({
                    ...draft,
                    categories: normalizeLibraryCategoryList(
                        draft.categories.filter(category => category !== target)
                    )
                });
            }

            $(config.status).textContent = `"${target}" 분류를 삭제했습니다.`;
            config.render();
        }

        function moveInfoCategory(kind, name, direction) {
            const config = getInfoCategoryConfig(kind);
            const target = normalizeLibraryCategoryName(name);
            const categories = config.getCategories();
            const index = categories.indexOf(target);
            if (index < 0) return;

            const nextIndex = direction === 'up' ? index - 1 : index + 1;
            if (nextIndex < 0 || nextIndex >= categories.length) return;

            [categories[index], categories[nextIndex]] = [categories[nextIndex], categories[index]];
            config.saveCategories(categories);
            config.render();
        }

        function handleInfoCategoryBarClick(event) {
            const control = event.target.closest('[data-info-category-scope]');
            if (!control) return;
            const kind = control.dataset.infoCategoryScope;
            if (kind !== 'resources' && kind !== 'memos') return;
            const config = getInfoCategoryConfig(kind);

            if (control.matches('[data-info-category-edit-toggle]')) {
                config.setEditMode(!config.getEditMode());
                config.render();
                return;
            }

            if (control.matches('[data-info-category-add]')) {
                const raw = window.prompt('새 분류 이름');
                if (raw === null) return;
                const name = normalizeLibraryCategoryName(raw);
                if (!name || name === '전체' || name === '+') {
                    $(config.status).textContent = '이 이름은 분류로 사용할 수 없습니다.';
                    return;
                }
                const categories = config.getCategories();
                if (categories.includes(name)) {
                    $(config.status).textContent = `"${name}" 분류는 이미 있습니다.`;
                    return;
                }
                categories.push(name);
                config.saveCategories(categories);
                config.render();
                $(config.status).textContent = `"${name}" 분류를 추가했습니다.`;
                return;
            }

            if (control.matches('[data-info-category-move]')) {
                moveInfoCategory(kind, control.dataset.infoCategoryName, control.dataset.infoCategoryMove);
                return;
            }

            if (control.matches('[data-info-category-delete]')) {
                deleteInfoCategory(kind, control.dataset.infoCategoryDelete);
                return;
            }

            if (control.matches('[data-info-category-filter]')) {
                const name = control.dataset.infoCategoryFilter;
                if (name === '__all__') config.active.clear();
                else if (config.active.has(name)) config.active.delete(name);
                else config.active.add(name);
                config.render();
            }
        }

        function handleInfoCategoryAssignment(button) {
            const kind = button.dataset.infoCategoryScope;
            const name = normalizeLibraryCategoryName(button.dataset.infoCategoryAssign);
            if (!name || (kind !== 'resources' && kind !== 'memos')) return false;
            const config = getInfoCategoryConfig(kind);
            const cardSelector = kind === 'resources' ? '[data-resource-id]' : '[data-memo-id]';
            const idKey = kind === 'resources' ? 'resourceId' : 'memoId';
            const card = button.closest(cardSelector);
            const id = card?.dataset[idKey];
            if (!id) return false;

            if (kind === 'resources' && resourceEditingId === id) syncResourceEditDraftFromDom();
            if (kind === 'memos' && memoEditingId === id) syncMemoEditDraftFromDom();

            const items = config.getItems();
            const index = items.findIndex(item => item.id === id);
            if (index < 0) return false;
            const item = config.normalizeItem(items[index]);

            const draft = config.getEditingDraft();
            const sourceCategories = draft?.id === id ? draft.categories : item.categories;
            const selected = new Set(normalizeLibraryCategoryList(sourceCategories));
            if (selected.has(name)) selected.delete(name);
            else selected.add(name);
            const nextCategories = normalizeLibraryCategoryList([...selected]);

            if (draft?.id === id) {
                config.setEditingDraft({ ...draft, categories: nextCategories });
            }

            items[index] = {
                ...item,
                categories: nextCategories,
                updatedAt: Date.now()
            };
            config.saveItems(items);
            config.render();
            return true;
        }

        function renderResources() {
            renderInfoCategoryBar('resources');
            if (resourceCreateOpen) renderResourceCreateCategoryAssignment();
            const query = String($('#nai-resource-search')?.value || '').trim().toLowerCase();
            const resources = getResources();
            const filtered = resources.filter(rawItem => {
                const item = normalizeResourceRecord(rawItem);
                const itemCategories = new Set(item.categories || []);
                if (![...activeResourceCategories].every(name => itemCategories.has(name))) return false;
                if (!query) return true;
                return [item.name, item.url, item.note]
                    .filter(Boolean)
                    .some(value => String(value).toLowerCase().includes(query));
            });
            const list = $('#nai-resource-list');
            if (!list) return;
            visibleResourceIds = filtered.map(rawItem => normalizeResourceRecord(rawItem).id);

            if (!filtered.length) {
                visibleResourceIds = [];
                list.innerHTML = `<div class="nai-library-empty">${resources.length ? '검색/분류 결과가 없습니다.' : '아직 저장한 자료가 없습니다.'}</div>`;
                return;
            }

            list.innerHTML = filtered.map(rawItem => {
                const item = normalizeResourceRecord(rawItem);
                const isEditing = resourceEditingId === item.id;
                if (isEditing) {
                    if (!resourceEditingDraft || resourceEditingDraft.id !== item.id) {
                        resourceEditingDraft = { ...item };
                    }
                    const draft = resourceEditingDraft;
                    return `
                        <article class="nai-info-card nai-info-edit-card" data-resource-id="${escapeHtml(item.id)}">
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">이름</label>
                                <input class="nai-loader-input" data-resource-edit-field="name" value="${escapeHtml(draft.name || '')}">
                            </div>
                            <div class="nai-loader-field nai-library-edit-category-field">
                                <label class="nai-loader-label">분류</label>
                                <div class="nai-library-card-category-row" aria-label="자료 분류">
                                    ${getResourceCategories().length
                                        ? renderInfoCategoryAssignment('resources', draft)
                                        : '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>'}
                                </div>
                            </div>
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">링크</label>
                                <input class="nai-loader-input" data-resource-edit-field="url" type="url" value="${escapeHtml(draft.url || '')}">
                            </div>
                            <div class="nai-loader-field" style="margin-bottom:0;">
                                <label class="nai-loader-label">메모 <span class="nai-loader-muted">(선택)</span></label>
                                <textarea class="nai-loader-textarea" data-resource-edit-field="note">${escapeHtml(draft.note || '')}</textarea>
                            </div>
                            <div class="nai-edit-footer-actions" style="margin-top:10px;">
                                <button type="button" class="nai-loader-action" data-resource-action="cancel-edit">취소</button>
                                <button type="button" class="nai-loader-action primary" data-resource-action="save-edit">수정 저장</button>
                            </div>
                        </article>`;
                }

                const title = item.name || fallbackResourceName(item.url);
                const selectedCategoryBadges = renderResourceSelectedCategoryBadges(item);
                return `
                    <article
                        class="nai-info-card nai-resource-card"
                        data-resource-id="${escapeHtml(item.id)}"
                        role="link"
                        tabindex="0"
                        aria-label="${escapeHtml(title)} 열기"
                        title="클릭해서 링크 열기"
                    >
                        <div class="nai-info-card-head">
                            <div class="nai-resource-title-group">
                                <button
                                    type="button"
                                    class="nai-resource-order-handle"
                                    data-resource-drag-handle
                                    title="누른 채 드래그하여 카드 순서 변경"
                                    aria-label="누른 채 드래그하여 카드 순서 변경"
                                >☰</button>
                                <div class="nai-info-card-title">${escapeHtml(title)}</div>
                            </div>
                        </div>
                        ${selectedCategoryBadges ? `
                            <div class="nai-resource-category-badges" aria-label="선택된 자료 분류">
                                ${selectedCategoryBadges}
                            </div>
                        ` : ''}
                        ${item.note ? `<div class="nai-info-note">${escapeHtml(item.note)}</div>` : ''}
                        <div class="nai-info-actions" data-resource-card-actions>
                            <button type="button" class="nai-loader-action danger" data-resource-action="delete">삭제</button>
                            <div class="nai-info-action-right">
                                <button type="button" class="nai-loader-action ghost" data-resource-action="share">공유</button>
                                <button type="button" class="nai-loader-action ghost" data-resource-action="edit">수정</button>
                            </div>
                        </div>
                    </article>`;
            }).join('');
        }

        function syncResourceEditDraftFromDom() {
            if (!resourceEditingId || !resourceEditingDraft) return;
            const card = $(`#nai-resource-list [data-resource-id="${CSS.escape(resourceEditingId)}"]`);
            if (!card) return;
            resourceEditingDraft = {
                ...resourceEditingDraft,
                name: String(card.querySelector('[data-resource-edit-field="name"]')?.value || '').trim(),
                url: String(card.querySelector('[data-resource-edit-field="url"]')?.value || '').trim(),
                note: String(card.querySelector('[data-resource-edit-field="note"]')?.value || '').trim()
            };
        }

        function addResource() {
            const status = $('#nai-resource-status');
            const url = normalizedExternalUrl($('#nai-resource-url')?.value);
            if (!url) {
                status.textContent = 'http/https 링크를 입력해주세요.';
                return;
            }
            const name = String($('#nai-resource-name')?.value || '').trim() || fallbackResourceName(url);
            const note = String($('#nai-resource-note')?.value || '').trim();
            const now = Date.now();
            const resources = getResources();
            const categories = normalizeLibraryCategoryList([...resourceCreateCategories]);
            resources.unshift({ id: createId(), name, url, note, categories, createdAt: now, updatedAt: now });
            saveResources(resources);
            clearResourceCreateForm();
            setCreatePanelOpen('resources', false);
            status.textContent = `"${name}" 자료를 저장했습니다.`;
            renderResources();
        }

        async function handleResourceAction(button) {
            const action = button.dataset.resourceAction;
            if (action === 'add') {
                addResource();
                return;
            }
            if (action === 'cancel-add') {
                clearResourceCreateForm();
                setCreatePanelOpen('resources', false);
                $('#nai-resource-status').textContent = '';
                return;
            }
            const card = button.closest('[data-resource-id]');
            const id = card?.dataset.resourceId;
            if (!id) return;
            const resources = getResources();
            const index = resources.findIndex(item => item.id === id);
            if (index < 0) return;
            const item = normalizeResourceRecord(resources[index]);
            const status = $('#nai-resource-status');

            if (action === 'open') {
                const url = normalizedExternalUrl(item.url);
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
                return;
            }
            if (action === 'share') {
                try {
                    const shareCode = createResourceShareCode(item);
                    const ok = await copyText(shareCode);
                    status.textContent = ok
                        ? `"${item.name || fallbackResourceName(item.url)}" 자료 공유 코드를 클립보드에 복사했습니다.`
                        : '자료 공유 코드 클립보드 복사에 실패했습니다.';
                } catch (error) {
                    status.textContent = `자료 공유 코드 생성 실패: ${error?.message || String(error)}`;
                }
                return;
            }
            if (action === 'edit') {
                resourceEditingId = id;
                resourceEditingDraft = { ...item };
                renderResources();
                return;
            }
            if (action === 'cancel-edit') {
                resourceEditingId = null;
                resourceEditingDraft = null;
                renderResources();
                return;
            }
            if (action === 'save-edit') {
                syncResourceEditDraftFromDom();
                const url = normalizedExternalUrl(resourceEditingDraft?.url);
                if (!url) {
                    status.textContent = 'http/https 링크를 입력해주세요.';
                    return;
                }
                const name = String(resourceEditingDraft?.name || '').trim() || fallbackResourceName(url);
                resources[index] = {
                    ...item,
                    ...resourceEditingDraft,
                    name,
                    url,
                    updatedAt: Date.now()
                };
                saveResources(resources);
                resourceEditingId = null;
                resourceEditingDraft = null;
                status.textContent = `"${name}" 자료를 수정했습니다.`;
                renderResources();
                return;
            }
            if (action === 'delete') {
                resources.splice(index, 1);
                saveResources(resources);
                if (resourceEditingId === id) {
                    resourceEditingId = null;
                    resourceEditingDraft = null;
                }
                status.textContent = `"${item.name || fallbackResourceName(item.url)}" 자료를 삭제했습니다.`;
                renderResources();
            }
        }

        function renderMemos() {
            renderInfoCategoryBar('memos');
            if (memoCreateOpen) renderMemoCreateCategoryAssignment();
            const query = String($('#nai-memo-search')?.value || '').trim().toLowerCase();
            const memos = getMemos();
            const filtered = memos.filter(rawItem => {
                const item = normalizeMemoRecord(rawItem);
                const itemCategories = new Set(item.categories || []);
                if (![...activeMemoCategories].every(name => itemCategories.has(name))) return false;
                if (!query) return true;
                return [item.title, item.content]
                    .filter(Boolean)
                    .some(value => String(value).toLowerCase().includes(query));
            });
            const list = $('#nai-memo-list');
            if (!list) return;
            visibleMemoIds = filtered.map(rawItem => normalizeMemoRecord(rawItem).id);

            if (!filtered.length) {
                visibleMemoIds = [];
                list.innerHTML = `<div class="nai-library-empty">${memos.length ? '검색/분류 결과가 없습니다.' : '아직 저장한 메모가 없습니다.'}</div>`;
                return;
            }

            list.innerHTML = filtered.map(rawItem => {
                const item = normalizeMemoRecord(rawItem);
                const isEditing = memoEditingId === item.id;
                if (isEditing) {
                    if (!memoEditingDraft || memoEditingDraft.id !== item.id) {
                        memoEditingDraft = { ...item };
                    }
                    const draft = memoEditingDraft;
                    return `
                        <article class="nai-info-card nai-info-edit-card" data-memo-id="${escapeHtml(item.id)}">
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">제목 <span class="nai-loader-muted">(선택)</span></label>
                                <input class="nai-loader-input" data-memo-edit-field="title" value="${escapeHtml(draft.title || '')}">
                            </div>
                            <div class="nai-loader-field nai-library-edit-category-field">
                                <label class="nai-loader-label">분류</label>
                                <div class="nai-library-card-category-row" aria-label="메모 분류">
                                    ${getMemoCategories().length
                                        ? renderInfoCategoryAssignment('memos', draft)
                                        : '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>'}
                                </div>
                            </div>
                            <div class="nai-loader-field" style="margin-bottom:0;">
                                <label class="nai-loader-label">내용</label>
                                <textarea class="nai-loader-textarea" data-memo-edit-field="content">${escapeHtml(draft.content || '')}</textarea>
                            </div>
                            <div class="nai-edit-footer-actions" style="margin-top:10px;">
                                <button type="button" class="nai-loader-action" data-memo-action="cancel-edit">취소</button>
                                <button type="button" class="nai-loader-action primary" data-memo-action="save-edit">수정 저장</button>
                            </div>
                        </article>`;
                }

                const selectedCategoryBadges = renderMemoSelectedCategoryBadges(item);
                return `
                    <article class="nai-info-card nai-memo-card" data-memo-id="${escapeHtml(item.id)}">
                        <div class="nai-info-card-head">
                            <div class="nai-memo-title-group">
                                <button
                                    type="button"
                                    class="nai-memo-order-handle"
                                    data-memo-drag-handle
                                    title="누른 채 드래그하여 메모 순서 변경"
                                    aria-label="누른 채 드래그하여 메모 순서 변경"
                                >☰</button>
                                <div class="nai-info-card-title">${escapeHtml(item.title || '메모')}</div>
                            </div>
                        </div>
                        ${selectedCategoryBadges ? `
                            <div class="nai-memo-category-badges" aria-label="선택된 메모 분류">
                                ${selectedCategoryBadges}
                            </div>
                        ` : ''}
                        <div class="nai-info-note">${escapeHtml(item.content)}</div>
                        <div class="nai-info-actions">
                            <button type="button" class="nai-loader-action danger" data-memo-action="delete">삭제</button>
                            <div class="nai-info-action-right">
                                <button type="button" class="nai-loader-action ghost" data-memo-action="share">공유</button>
                                <button type="button" class="nai-loader-action ghost" data-memo-action="edit">수정</button>
                            </div>
                        </div>
                    </article>`;
            }).join('');
        }

        function syncMemoEditDraftFromDom() {
            if (!memoEditingId || !memoEditingDraft) return;
            const card = $(`#nai-memo-list [data-memo-id="${CSS.escape(memoEditingId)}"]`);
            if (!card) return;
            memoEditingDraft = {
                ...memoEditingDraft,
                title: String(card.querySelector('[data-memo-edit-field="title"]')?.value || '').trim(),
                content: String(card.querySelector('[data-memo-edit-field="content"]')?.value || '').trim()
            };
        }

        function addMemo() {
            const status = $('#nai-memo-status');
            const title = String($('#nai-memo-title')?.value || '').trim();
            const content = String($('#nai-memo-content')?.value || '').trim();
            if (!content) {
                status.textContent = '메모 내용을 입력해주세요.';
                return;
            }
            const now = Date.now();
            const memos = getMemos();
            const categories = normalizeLibraryCategoryList([...memoCreateCategories]);
            memos.unshift({ id: createId(), title, content, categories, createdAt: now, updatedAt: now });
            saveMemos(memos);
            clearMemoCreateForm();
            setCreatePanelOpen('memos', false);
            status.textContent = title ? `"${title}" 메모를 저장했습니다.` : '메모를 저장했습니다.';
            renderMemos();
        }

        async function handleMemoAction(button) {
            const action = button.dataset.memoAction;
            if (action === 'add') {
                addMemo();
                return;
            }
            if (action === 'cancel-add') {
                clearMemoCreateForm();
                setCreatePanelOpen('memos', false);
                $('#nai-memo-status').textContent = '';
                return;
            }
            const card = button.closest('[data-memo-id]');
            const id = card?.dataset.memoId;
            if (!id) return;
            const memos = getMemos();
            const index = memos.findIndex(item => item.id === id);
            if (index < 0) return;
            const item = normalizeMemoRecord(memos[index]);
            const status = $('#nai-memo-status');

            if (action === 'share') {
                try {
                    const shareCode = createMemoShareCode(item);
                    const ok = await copyText(shareCode);
                    const label = item.title ? `"${item.title}"` : '메모';
                    status.textContent = ok
                        ? `${label} 공유 코드를 클립보드에 복사했습니다.`
                        : '메모 공유 코드 클립보드 복사에 실패했습니다.';
                } catch (error) {
                    status.textContent = `메모 공유 코드 생성 실패: ${error?.message || String(error)}`;
                }
                return;
            }
            if (action === 'edit') {
                memoEditingId = id;
                memoEditingDraft = { ...item };
                renderMemos();
                return;
            }
            if (action === 'cancel-edit') {
                memoEditingId = null;
                memoEditingDraft = null;
                renderMemos();
                return;
            }
            if (action === 'save-edit') {
                syncMemoEditDraftFromDom();
                const content = String(memoEditingDraft?.content || '').trim();
                if (!content) {
                    status.textContent = '메모 내용을 입력해주세요.';
                    return;
                }
                memos[index] = {
                    ...item,
                    ...memoEditingDraft,
                    content,
                    updatedAt: Date.now()
                };
                saveMemos(memos);
                memoEditingId = null;
                memoEditingDraft = null;
                status.textContent = '메모를 수정했습니다.';
                renderMemos();
                return;
            }
            if (action === 'delete') {
                memos.splice(index, 1);
                saveMemos(memos);
                if (memoEditingId === id) {
                    memoEditingId = null;
                    memoEditingDraft = null;
                }
                status.textContent = '메모를 삭제했습니다.';
                renderMemos();
            }
        }

        function syncManualDraftFromDom() {
            const card = $('#nai-manual-editor-root [data-manual-edit-card]');
            if (!card) return;

            const currentCharacters = Array.isArray(manualDraft.characters)
                ? manualDraft.characters
                : [];

            const characters = [...card.querySelectorAll('[data-manual-character-index]')]
                .map(characterCard => {
                    const index = Number(characterCard.dataset.manualCharacterIndex);
                    const current = currentCharacters[index] || {};
                    const prompt = String(
                        characterCard.querySelector('[data-manual-character-field="prompt"]')?.value || ''
                    ).trim();
                    const negativePrompt = String(
                        characterCard.querySelector('[data-manual-character-field="negativePrompt"]')?.value || ''
                    ).trim();

                    return {
                        name:
                            String(current.name || '').trim() ||
                            `Character ${index + 1}`,
                        prompt,
                        negativePrompt,
                        ...(!prompt && !negativePrompt ? { _analysisDraft: true } : {})
                    };
                });

            manualDraft = {
                ...manualDraft,
                name: String(card.querySelector('[data-manual-field="name"]')?.value || '').trim(),
                note: String(card.querySelector('[data-manual-field="note"]')?.value || '').trim(),
                sourceUrl: String(card.querySelector('[data-manual-field="sourceUrl"]')?.value || '').trim(),
                tags: String(card.querySelector('[data-manual-field="tags"]')?.value || '').trim(),
                negativeTags: String(card.querySelector('[data-manual-field="negativeTags"]')?.value || '').trim(),
                characters
            };
        }

        function renderManualAddEditor() {
            const root = $('#nai-manual-editor-root');
            if (!root) return;

            const characters = Array.isArray(manualDraft.characters)
                ? manualDraft.characters
                : [];
            const manualNoteOpen =
                typeof manualDraft._noteOpen === 'boolean'
                    ? manualDraft._noteOpen
                    : !!String(manualDraft.note || '').trim();

            root.innerHTML = `
                <article class="nai-concept-card" data-manual-edit-card>
                    <div class="nai-concept-card-header">
                        <div class="nai-concept-name">새 컨셉</div>
                        <button
                            type="button"
                            class="nai-inline-note-toggle"
                            data-manual-note-toggle
                            aria-expanded="${manualNoteOpen ? 'true' : 'false'}"
                        >메모 ${manualNoteOpen ? '▼' : '◀'}</button>
                    </div>

                    <div
                        class="nai-inline-note-body"
                        data-manual-note-body
                        ${manualNoteOpen ? '' : 'hidden'}
                    >
                        <textarea
                            class="nai-loader-textarea nai-note-editor"
                            data-manual-field="note"
                            placeholder="설명 / 사용 팁 / 주의사항"
                        >${escapeHtml(manualDraft.note || '')}</textarea>
                    </div>

                    <div class="nai-loader-field">
                        <label class="nai-loader-label">이름</label>
                        <input
                            class="nai-loader-input"
                            data-manual-field="name"
                            type="text"
                            value="${escapeHtml(manualDraft.name || '')}"
                            placeholder="예: 메이드복"
                        >
                    </div>

                    <div class="nai-loader-field nai-library-edit-category-field">
                        <label class="nai-loader-label">분류</label>
                        <div id="nai-manual-create-categories" class="nai-library-card-category-row" aria-label="새 컨셉 분류">
                            ${getLibraryCategories().length
                                ? renderManualCreateCategoryAssignmentHtml()
                                : '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>'}
                        </div>
                    </div>

                    <div class="nai-analysis-prompt-editor" data-manual-prompt-editor>
                        <div class="nai-analysis-prompt-tabs">
                            <button type="button" class="nai-analysis-prompt-tab active" data-analysis-prompt-tab="prompt">Base Prompt</button>
                            <button type="button" class="nai-analysis-prompt-tab" data-analysis-prompt-tab="negative">Undesired Content</button>
                        </div>
                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                            <textarea
                                class="nai-loader-textarea"
                                data-manual-field="tags"
                                placeholder="Base Prompt"
                            >${escapeHtml(manualDraft.tags || '')}</textarea>
                        </div>
                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                            <textarea
                                class="nai-loader-textarea"
                                data-manual-field="negativeTags"
                                placeholder="Undesired Content"
                            >${escapeHtml(manualDraft.negativeTags || '')}</textarea>
                        </div>
                    </div>

                    <div class="nai-ai-result-head" style="margin-top:12px; margin-bottom:8px;">
                        <div class="nai-loader-label" style="margin:0;">Character Prompts</div>
                        <div class="nai-ai-extra-options">
                            <button
                                type="button"
                                class="nai-ai-add-character"
                                data-manual-edit-action="add-character"
                            >+ 캐릭터프롬 추가</button>
                        </div>
                    </div>

                    ${characters.length ? `
                        <div class="nai-character-group">
                            ${characters.map((character, characterIndex) => `
                                <div class="nai-ai-character-block" data-manual-character-index="${characterIndex}">
                                    <div class="nai-ai-character-title-row">
                                        <div class="nai-character-title" style="margin-bottom:0;">
                                            ${escapeHtml(character.name || `Character ${characterIndex + 1}`)}
                                        </div>
                                        <button
                                            type="button"
                                            class="nai-ai-character-remove"
                                            data-manual-edit-action="remove-character"
                                            title="이 Character Prompt 삭제"
                                            aria-label="이 Character Prompt 삭제"
                                        >×</button>
                                    </div>

                                    <div class="nai-analysis-prompt-editor" data-manual-prompt-editor style="margin-bottom:0;">
                                        <div class="nai-analysis-prompt-tabs">
                                            <button type="button" class="nai-analysis-prompt-tab active" data-analysis-prompt-tab="prompt">Prompt</button>
                                            <button type="button" class="nai-analysis-prompt-tab" data-analysis-prompt-tab="negative">Undesired Content</button>
                                        </div>
                                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                                            <textarea
                                                class="nai-loader-textarea"
                                                data-manual-character-field="prompt"
                                                placeholder="Character ${characterIndex + 1} Prompt"
                                            >${escapeHtml(character.prompt || '')}</textarea>
                                        </div>
                                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                                            <textarea
                                                class="nai-loader-textarea"
                                                data-manual-character-field="negativePrompt"
                                                placeholder="Character ${characterIndex + 1} Undesired Content"
                                            >${escapeHtml(character.negativePrompt || '')}</textarea>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}

                    <div class="nai-loader-field" style="margin-top:12px; margin-bottom:0;">
                        <label class="nai-loader-label">원본 링크 <span class="nai-loader-muted">(선택)</span></label>
                        <input
                            class="nai-loader-input"
                            data-manual-field="sourceUrl"
                            type="url"
                            value="${escapeHtml(manualDraft.sourceUrl || '')}"
                            placeholder="https://..."
                        >
                    </div>

                    <div class="nai-concept-footer">
                        <div class="nai-edit-footer-actions">
                            <button type="button" class="nai-loader-action" data-manual-edit-action="cancel-add">취소</button>
                            <button type="button" class="nai-loader-action primary" data-action="save-import">라이브러리에 저장</button>
                        </div>
                    </div>
                </article>
            `;

            requestAnimationFrame(() => {
                root.querySelectorAll('.nai-loader-textarea').forEach(textarea => {
                    const panel = textarea.closest('[data-analysis-prompt-panel]');
                    if (panel?.hidden) return;
                    fitAnalysisTextarea(textarea);
                });
            });
        }

        function syncLibraryEditDraftFromDom() {
            if (!editingId || !editingDraft) return;

            const card = $('#nai-library-list [data-library-edit-card]');
            if (!card) return;

            const nameField = card.querySelector('[data-edit-field="name"]');
            const noteField = card.querySelector('[data-edit-field="note"]');
            const sourceUrlField = card.querySelector('[data-edit-field="sourceUrl"]');
            const tagsField = card.querySelector('[data-edit-field="tags"]');
            const negativeField = card.querySelector('[data-edit-field="negativeTags"]');

            const currentCharacters = Array.isArray(editingDraft.characters)
                ? editingDraft.characters
                : [];

            const characters = [...card.querySelectorAll('[data-edit-character-index]')]
                .map(characterCard => {
                    const index = Number(characterCard.dataset.editCharacterIndex);
                    const current = currentCharacters[index] || {};
                    const prompt = String(
                        characterCard.querySelector('[data-edit-character-field="prompt"]')?.value || ''
                    ).trim();
                    const negativePrompt = String(
                        characterCard.querySelector('[data-edit-character-field="negativePrompt"]')?.value || ''
                    ).trim();

                    return {
                        name:
                            String(current.name || '').trim() ||
                            `Character ${index + 1}`,
                        prompt,
                        negativePrompt,
                        ...(!prompt && !negativePrompt ? { _analysisDraft: true } : {})
                    };
                });

            editingDraft = {
                ...editingDraft,
                name: String(nameField?.value || editingDraft.name || '').trim(),
                note: String(noteField?.value || '').trim(),
                source: {
                    ...(editingDraft.source || {}),
                    url: String(sourceUrlField?.value || '').trim()
                },
                tags: String(tagsField?.value || '').trim(),
                negativeTags: String(negativeField?.value || '').trim(),
                characters
            };
        }

        function cleanLibraryEditCharacters(rows) {
            return normalizeCharacterRows(
                (Array.isArray(rows) ? rows : []).map(row => ({
                    ...row,
                    _analysisDraft: false
                }))
            );
        }

        function renderLibraryCategoryBar() {
            const bar = $('#nai-library-category-bar');
            if (!bar) return;

            const categories = getLibraryCategories();
            const valid = new Set(categories);
            [...activeLibraryCategories].forEach(name => {
                if (!valid.has(name)) activeLibraryCategories.delete(name);
            });

            const filters = [
                `<button type="button" class="nai-library-category-chip${activeLibraryCategories.size ? '' : ' active'}" data-library-category-filter="__all__">전체</button>`
            ];

            categories.forEach(name => {
                filters.push(
                    `<button type="button" class="nai-library-category-chip${activeLibraryCategories.has(name) ? ' active' : ''}" data-library-category-filter="${escapeHtml(name)}">${escapeHtml(name)}</button>`
                );
            });

            const manager = libraryCategoryEditMode ? `
                <div class="nai-library-category-manager" data-library-category-manager>
                    ${categories.length ? categories.map((name, index) => `
                        <div class="nai-library-category-manager-row" data-library-category-manager-row="${escapeHtml(name)}">
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-library-category-move="up"
                                data-library-category-name="${escapeHtml(name)}"
                                title="위로 이동"
                                ${index === 0 ? 'disabled' : ''}
                            >↑</button>
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-library-category-move="down"
                                data-library-category-name="${escapeHtml(name)}"
                                title="아래로 이동"
                                ${index === categories.length - 1 ? 'disabled' : ''}
                            >↓</button>
                            <input
                                type="text"
                                class="nai-loader-input nai-loader-grow"
                                value="${escapeHtml(name)}"
                                data-library-category-rename="${escapeHtml(name)}"
                                aria-label="${escapeHtml(name)} 분류 이름"
                            >
                            <button
                                type="button"
                                class="nai-library-category-manager-button danger"
                                data-library-category-delete="${escapeHtml(name)}"
                            >삭제</button>
                        </div>
                    `).join('') : '<div class="nai-library-category-empty">아직 만든 분류가 없습니다.</div>'}
                </div>
            ` : '';

            bar.innerHTML = `
                <div class="nai-library-category-filter-group">
                    ${filters.join('')}
                </div>
                <div class="nai-library-category-tools">
                    <button
                        type="button"
                        class="nai-library-category-chip nai-library-category-edit-button${libraryCategoryEditMode ? ' active' : ''}"
                        data-library-category-edit-toggle
                        aria-expanded="${libraryCategoryEditMode ? 'true' : 'false'}"
                    >${libraryCategoryEditMode ? '완료' : '수정'}</button>
                    <button
                        type="button"
                        class="nai-library-category-chip nai-category-add"
                        data-library-category-add
                        title="새 분류 추가"
                        aria-label="새 분류 추가"
                    >+</button>
                </div>
                ${manager}
            `;
        }

        function renderLibraryCategoryAssignment(item) {
            const categories = getLibraryCategories();
            if (!categories.length) return '';

            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-library-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderAnalysisCategoryAssignment(item) {
            const categories = getLibraryCategories();
            if (!categories.length) {
                return '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
            }

            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-result-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renameLibraryCategory(oldName, rawNewName) {
            const previous = normalizeLibraryCategoryName(oldName);
            const next = normalizeLibraryCategoryName(rawNewName);
            if (!previous) return false;

            if (!next || next === '전체' || next === '+') {
                $('#nai-library-status').textContent = '이 이름은 분류로 사용할 수 없습니다.';
                renderLibrary();
                return false;
            }
            if (previous === next) return true;

            const categories = getLibraryCategories();
            if (categories.includes(next)) {
                $('#nai-library-status').textContent = `"${next}" 분류는 이미 있습니다.`;
                renderLibrary();
                return false;
            }

            const categoryIndex = categories.indexOf(previous);
            if (categoryIndex < 0) return false;
            categories[categoryIndex] = next;
            saveLibraryCategories(categories);

            const library = getLibrary().map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).map(name => name === previous ? next : name)
                    )
                };
            });
            saveLibrary(library);

            if (activeLibraryCategories.delete(previous)) {
                activeLibraryCategories.add(next);
            }
            if (editingDraft?.categories) {
                editingDraft.categories = normalizeLibraryCategoryList(
                    editingDraft.categories.map(name => name === previous ? next : name)
                );
            }

            $('#nai-library-status').textContent = `"${previous}" → "${next}"로 변경했습니다.`;
            renderLibrary();
            return true;
        }

        function deleteLibraryCategory(name) {
            const target = normalizeLibraryCategoryName(name);
            if (!target) return;
            if (!window.confirm(`"${target}" 분류를 삭제할까요?\n카드에 지정된 이 분류도 함께 제거됩니다.`)) return;

            saveLibraryCategories(
                getLibraryCategories().filter(category => category !== target)
            );

            const library = getLibrary().map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).filter(category => category !== target)
                    )
                };
            });
            saveLibrary(library);

            activeLibraryCategories.delete(target);
            if (editingDraft?.categories) {
                editingDraft.categories = normalizeLibraryCategoryList(
                    editingDraft.categories.filter(category => category !== target)
                );
            }

            $('#nai-library-status').textContent = `"${target}" 분류를 삭제했습니다.`;
            renderLibrary();
        }

        function moveLibraryCategory(name, direction) {
            const target = normalizeLibraryCategoryName(name);
            const categories = getLibraryCategories();
            const index = categories.indexOf(target);
            if (index < 0) return;

            const nextIndex = direction === 'up' ? index - 1 : index + 1;
            if (nextIndex < 0 || nextIndex >= categories.length) return;

            [categories[index], categories[nextIndex]] = [categories[nextIndex], categories[index]];
            saveLibraryCategories(categories);
            renderLibrary();
        }

        function saveVisibleLibraryOrder(orderedVisibleIds) {
            const library = getLibrary();
            if (!library.length) return false;

            const byId = new Map(library.map(item => [item.id, item]));
            const visibleSet = new Set(
                visibleLibraryIds.filter(id => byId.has(id))
            );
            if (visibleSet.size < 2) return false;

            const nextVisibleOrder = [];
            orderedVisibleIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });
            visibleLibraryIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });

            let cursor = 0;
            const reordered = library.map(item => {
                if (!visibleSet.has(item.id)) return item;
                const nextId = nextVisibleOrder[cursor++];
                return byId.get(nextId) || item;
            });

            saveLibrary(reordered);
            return true;
        }

        function renderLibrary() {
            renderLibraryCategoryBar();
            if (libraryCreateOpen) renderManualCreateCategoryAssignment();

            const query =
                ($('#nai-library-search').value || '')
                    .trim()
                    .toLowerCase();

            const library = getLibrary();

            const filtered = library.filter(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const itemCategories = new Set(item.categories || []);

                const categoryMatches = [...activeLibraryCategories]
                    .every(name => itemCategories.has(name));
                if (!categoryMatches) return false;

                if (!query) return true;

                const characterText = (item.characters || [])
                    .flatMap(character => [
                        character.name,
                        character.prompt,
                        character.negativePrompt
                    ]);

                return [
                    item.name,
                    item.tags,
                    item.negativeTags,
                    item.note,
                    ...characterText,
                    item?.source?.url,
                    item?.source?.type
                ]
                    .filter(Boolean)
                    .some(value =>
                        String(value).toLowerCase().includes(query)
                    );
            });

            const list = $('#nai-library-list');
            visibleLibraryIds = filtered.map(rawItem => normalizeConceptRecord(rawItem).id);

            if (!filtered.length) {
                visibleLibraryIds = [];
                list.innerHTML = `
                    <div class="nai-library-empty">
                        ${
                            library.length
                                ? '검색 결과가 없습니다.'
                                : '아직 저장한 컨셉이 없습니다.<br>가져오기 탭에서 첫 컨셉을 저장해보세요.'
                        }
                    </div>
                `;
                return;
            }

            list.innerHTML = filtered.map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const sourceUrl = item?.source?.url || '';
                const isEditing = editingId === item.id;

                if (isEditing) {
                    if (!editingDraft || editingDraft.id !== item.id) {
                        editingDraft = {
                            ...item,
                            characters: (item.characters || []).map(character => ({ ...character }))
                        };
                    }

                    const draft = editingDraft;
                    const characters = Array.isArray(draft.characters)
                        ? draft.characters
                        : [];
                    const editNoteOpen =
                        typeof draft._noteOpen === 'boolean'
                            ? draft._noteOpen
                            : !!String(draft.note || '').trim();

                    return `
                        <article
                            class="nai-concept-card"
                            data-concept-id="${escapeHtml(item.id)}"
                            data-library-edit-card
                        >
                            <div class="nai-concept-card-header">
                                <div class="nai-concept-name">${escapeHtml(item.name)} · 수정</div>
                                <button
                                    type="button"
                                    class="nai-inline-note-toggle"
                                    data-library-edit-note-toggle
                                    aria-expanded="${editNoteOpen ? 'true' : 'false'}"
                                >메모 ${editNoteOpen ? '▼' : '◀'}</button>
                            </div>

                            <div
                                class="nai-inline-note-body"
                                data-library-edit-note-body
                                ${editNoteOpen ? '' : 'hidden'}
                            >
                                <textarea
                                    class="nai-loader-textarea nai-note-editor"
                                    data-edit-field="note"
                                    placeholder="설명 / 사용 팁 / 주의사항"
                                >${escapeHtml(draft.note || '')}</textarea>
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">이름</label>
                                <input
                                    class="nai-loader-input"
                                    data-edit-field="name"
                                    type="text"
                                    value="${escapeHtml(draft.name ?? item.name)}"
                                >
                            </div>

                            ${getLibraryCategories().length ? `
                                <div class="nai-loader-field nai-library-edit-category-field">
                                    <label class="nai-loader-label">분류</label>
                                    <div class="nai-library-card-category-row" aria-label="컨셉 분류">
                                        ${renderLibraryCategoryAssignment(draft)}
                                    </div>
                                </div>
                            ` : ''}

                            <div
                                class="nai-analysis-prompt-editor"
                                data-library-prompt-editor
                            >
                                <div class="nai-analysis-prompt-tabs">
                                    <button
                                        type="button"
                                        class="nai-analysis-prompt-tab active"
                                        data-analysis-prompt-tab="prompt"
                                    >Base Prompt</button>
                                    <button
                                        type="button"
                                        class="nai-analysis-prompt-tab"
                                        data-analysis-prompt-tab="negative"
                                    >Undesired Content</button>
                                </div>

                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                                    <textarea
                                        class="nai-loader-textarea"
                                        data-edit-field="tags"
                                        placeholder="Base Prompt"
                                    >${escapeHtml(draft.tags || '')}</textarea>
                                </div>

                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                                    <textarea
                                        class="nai-loader-textarea"
                                        data-edit-field="negativeTags"
                                        placeholder="Negative Prompt / Undesired Content"
                                    >${escapeHtml(draft.negativeTags || '')}</textarea>
                                </div>
                            </div>

                            <div class="nai-ai-result-head" style="margin-top:12px; margin-bottom:8px;">
                                <div class="nai-loader-label" style="margin:0;">Character Prompts</div>
                                <div class="nai-ai-extra-options">
                                    <button
                                        type="button"
                                        class="nai-ai-add-character"
                                        data-library-edit-action="add-character"
                                            >+ 캐릭터프롬 추가</button>
                                </div>
                            </div>

                            ${characters.length ? `
                                <div class="nai-character-group">
                                    ${characters.map((character, characterIndex) => `
                                        <div
                                            class="nai-ai-character-block"
                                            data-edit-character-index="${characterIndex}"
                                        >
                                            <div class="nai-ai-character-title-row">
                                                <div class="nai-character-title" style="margin-bottom:0;">
                                                    ${escapeHtml(character.name || `Character ${characterIndex + 1}`)}
                                                </div>
                                                <button
                                                    type="button"
                                                    class="nai-ai-character-remove"
                                                    data-library-edit-action="remove-character"
                                                    title="이 Character Prompt 삭제"
                                                    aria-label="이 Character Prompt 삭제"
                                                >×</button>
                                            </div>

                                            <div class="nai-analysis-prompt-editor" data-library-prompt-editor style="margin-bottom:0;">
                                                <div class="nai-analysis-prompt-tabs">
                                                    <button
                                                        type="button"
                                                        class="nai-analysis-prompt-tab active"
                                                        data-analysis-prompt-tab="prompt"
                                                    >Prompt</button>
                                                    <button
                                                        type="button"
                                                        class="nai-analysis-prompt-tab"
                                                        data-analysis-prompt-tab="negative"
                                                    >Undesired Content</button>
                                                </div>

                                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                                                    <textarea
                                                        class="nai-loader-textarea"
                                                        data-edit-character-field="prompt"
                                                        placeholder="Character ${characterIndex + 1} Prompt"
                                                    >${escapeHtml(character.prompt || '')}</textarea>
                                                </div>

                                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                                                    <textarea
                                                        class="nai-loader-textarea"
                                                        data-edit-character-field="negativePrompt"
                                                        placeholder="Character ${characterIndex + 1} Undesired Content"
                                                    >${escapeHtml(character.negativePrompt || '')}</textarea>
                                                </div>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : ''}

                            <div class="nai-loader-field" style="margin-top:12px; margin-bottom:0;">
                                <label class="nai-loader-label">원본 링크 <span class="nai-loader-muted">(선택)</span></label>
                                <input
                                    class="nai-loader-input"
                                    data-edit-field="sourceUrl"
                                    type="url"
                                    value="${escapeHtml(draft?.source?.url || '')}"
                                    placeholder="https://..."
                                >
                            </div>

                            <div class="nai-concept-footer">
                                <div class="nai-edit-footer-actions">
                                    <button
                                        type="button"
                                        class="nai-loader-action"
                                        data-concept-action="cancel-edit"
                                    >취소</button>
                                    <button
                                        type="button"
                                        class="nai-loader-action primary"
                                        data-concept-action="save-edit"
                                    >수정 저장</button>
                                </div>
                            </div>
                        </article>
                    `;
                }

                const characters = item.characters || [];
                const cardOpen = expandedLibraryCards.has(item.id);
                const noteOpen = expandedLibraryNotes.has(item.id);

                return `
                    <article
                        class="nai-concept-card${cardOpen ? '' : ' nai-library-card-collapsed'}"
                        data-concept-id="${escapeHtml(item.id)}"
                    >
                        <div
                            class="nai-library-card-summary"
                            data-library-card-toggle
                            aria-expanded="${cardOpen ? 'true' : 'false'}"
                            title="컨셉 내용 ${cardOpen ? '접기' : '펼치기'}"
                        >
                            <div class="nai-library-card-summary-main">
                                <div class="nai-library-card-toggle">
                                    <button
                                        type="button"
                                        class="nai-library-order-handle"
                                        data-library-drag-handle
                                        title="누른 채 드래그하여 카드 순서 변경"
                                        aria-label="누른 채 드래그하여 카드 순서 변경"
                                    >☰</button>
                                    <span class="nai-concept-name" data-library-title-marquee><span class="nai-library-title-marquee-text">${escapeHtml(item.name)}</span></span>
                                    <span class="nai-card-note-separator" data-library-note-separator ${item.note ? '' : 'hidden'}>·</span>
                                    <span class="nai-card-note-preview" data-library-note-preview ${item.note ? '' : 'hidden'}>${escapeHtml(item.note || '')}</span>
                                </div>
                            </div>
                            <div class="nai-library-summary-actions">
                                <button type="button" class="nai-loader-action" data-concept-action="edit">수정</button>
                                <button type="button" class="nai-loader-action primary" data-concept-action="use">사용</button>
                            </div>
                        </div>

                        <div class="nai-library-card-body" data-library-card-body ${cardOpen ? '' : 'hidden'}>
                            <div class="nai-library-card-category-row" aria-label="컨셉 분류">
                                ${renderLibraryCategoryAssignment(item)}
                            </div>

                            ${item.tags ? `
                                <div class="nai-loader-label" style="margin-top:2px;">Base Prompt</div>
                                <div class="nai-concept-tags">${escapeHtml(item.tags)}</div>
                            ` : ''}

                            ${item.negativeTags ? `
                                <div class="nai-loader-label" style="margin-top:10px;">Undesired Content</div>
                                <div class="nai-concept-tags">${escapeHtml(item.negativeTags)}</div>
                            ` : ''}

                            ${characters.length ? `
                                <div class="nai-loader-label" style="margin-top:12px;">Character Prompts</div>
                                <div class="nai-character-group">
                                    ${characters.map((character, characterIndex) => `
                                        <div class="nai-character-block">
                                            <div class="nai-character-title">
                                                ${escapeHtml(character.name || `Character ${characterIndex + 1}`)}
                                            </div>
                                            ${character.prompt ? `
                                                <div class="nai-character-subtitle">Prompt</div>
                                                <div class="nai-concept-tags">${escapeHtml(character.prompt)}</div>
                                            ` : ''}
                                            ${character.negativePrompt ? `
                                                <div class="nai-character-subtitle">Undesired Content</div>
                                                <div class="nai-concept-tags">${escapeHtml(character.negativePrompt)}</div>
                                            ` : ''}
                                        </div>
                                    `).join('')}
                                </div>
                            ` : ''}

                            <div class="nai-concept-footer">
                                <div class="nai-concept-actions">
                                    <button type="button" class="nai-loader-action danger" data-concept-action="delete">삭제</button>
                                    <div class="nai-concept-action-right">
                                        <button type="button" class="nai-loader-action" data-concept-action="share">공유</button>
                                        ${sourceUrl ? `<button type="button" class="nai-loader-action ghost" data-concept-action="source">원본</button>` : ''}
                                        <button
                                            type="button"
                                            class="nai-loader-action${noteOpen ? ' nai-library-note-active' : ''}"
                                            data-library-note-toggle
                                            aria-expanded="${noteOpen ? 'true' : 'false'}"
                                        >메모</button>
                                        <button type="button" class="nai-loader-action" data-concept-action="edit">수정</button>
                                        ${item.negativeTags ? `<button type="button" class="nai-loader-action" data-concept-action="copy-negative">네거 복사</button>` : ''}
                                        ${item.tags ? `<button type="button" class="nai-loader-action" data-concept-action="copy">복사</button>` : ''}
                                        <button type="button" class="nai-loader-action primary" data-concept-action="use">사용</button>
                                    </div>
                                </div>
                            </div>

                            <div class="nai-library-note-body" data-library-note-body ${noteOpen ? '' : 'hidden'}>
                                <textarea
                                    class="nai-loader-textarea nai-note-editor"
                                    data-library-note
                                    placeholder="설명 / 사용 팁 / 주의사항"
                                >${escapeHtml(item.note || '')}</textarea>
                            </div>
                        </div>
                    </article>
                `;
            }).join('');

            requestAnimationFrame(() => {
                updateLibraryTitleMarquees(list);

                list.querySelectorAll('[data-library-edit-card] .nai-loader-textarea').forEach(textarea => {
                    const panel = textarea.closest('[data-analysis-prompt-panel]');
                    if (panel?.hidden) return;
                    fitAnalysisTextarea(textarea);
                });

                list.querySelectorAll('[data-library-note-body]:not([hidden]) [data-library-note]').forEach(textarea => {
                    fitAnalysisTextarea(textarea);
                });
            });
        }

        function updateLibraryTitleMarquees(root = document) {
            root.querySelectorAll?.('[data-library-title-marquee]').forEach(viewport => {
                const text = viewport.querySelector('.nai-library-title-marquee-text');
                if (!text) return;

                viewport.classList.remove('nai-title-overflowing');
                viewport.style.removeProperty('--nai-library-title-shift');
                text.style.transform = '';

                const overflow = Math.ceil(text.scrollWidth - viewport.clientWidth);
                if (overflow > 4) {
                    viewport.style.setProperty('--nai-library-title-shift', `${-(overflow + 4)}px`);
                    viewport.classList.add('nai-title-overflowing');
                }
            });
        }

        function fitAnalysisTextarea(textarea) {
            if (!textarea || textarea.hidden) return;
            textarea.style.height = 'auto';
            const next = Math.min(
                260,
                Math.max(56, textarea.scrollHeight + 2)
            );
            textarea.style.height = `${next}px`;
        }

        function activateAnalysisPromptTab(editor, tabName) {
            if (!editor) return;
            const nextTab = tabName === 'negative' ? 'negative' : 'prompt';

            editor.querySelectorAll('[data-analysis-prompt-tab]').forEach(button => {
                button.classList.toggle(
                    'active',
                    button.dataset.analysisPromptTab === nextTab
                );
            });

            editor.querySelectorAll('[data-analysis-prompt-panel]').forEach(panel => {
                panel.hidden = panel.dataset.analysisPromptPanel !== nextTab;
            });

            requestAnimationFrame(() => {
                editor.querySelectorAll(
                    '[data-analysis-prompt-panel]:not([hidden]) .nai-loader-textarea'
                ).forEach(fitAnalysisTextarea);
            });
        }

        function nextAnalysisCharacterName(characters) {
            return `Character ${characters.length + 1}`;
        }

        function renumberAnalysisCharacters(characters) {
            return normalizeCharacterRows(characters).map((character, index) => ({
                ...character,
                name: /^Character\s+\d+$/i.test(String(character.name || '').trim())
                    ? `Character ${index + 1}`
                    : character.name
            }));
        }


        function renderAnalysisResults() {
            const wrap = $('#nai-analysis-wrap');
            const list = $('#nai-ai-results');

            if (!wrap || !list) return;

            if (!analysisResults.length) {
                wrap.style.display = 'none';
                list.innerHTML = '';
                return;
            }

            wrap.style.display = 'block';

            const methodLabel =
                analysisMeta?.method === 'share-code'
                    ? '공유 코드'
                    : analysisMeta?.method === 'direct-fetch'
                        ? '직접 원문 fallback'
                        : analysisMeta?.method === 'notion-browser-crawl'
                            ? `Notion 실제 화면 ${analysisMeta?.pagesVisited || 0}페이지`
                            : analysisMeta?.method === 'notion-tree'
                                ? `Notion 트리 ${analysisMeta?.pagesVisited || 0}페이지${
                                    analysisMeta?.assetsVisited
                                        ? ` + 첨부 ${analysisMeta.assetsVisited}`
                                        : ''
                                }`
                                : 'URL Context';

            $('#nai-analysis-meta').textContent =
                `${analysisMeta?.pageTitle || '제목 없음'} · ${methodLabel} · ${analysisResults.length}개 세트 발견`;

            list.innerHTML = analysisResults.map((rawItem, index) => {
                const item = normalizeConceptRecord(rawItem);
                const characters = item.characters || [];
                const duplicateItem = findLibraryExactDuplicate(item);
                const resultNoteOpen =
                    typeof item._noteOpen === 'boolean'
                        ? item._noteOpen
                        : !!String(item.note || '').trim();

                return `
                    <article
                        class="nai-ai-result-card"
                        data-result-id="${escapeHtml(item.id)}"
                    >
                        <div class="nai-ai-result-head">
                            <input
                                type="checkbox"
                                data-result-field="selected"
                                ${item.selected ? 'checked' : ''}
                            >

                            <div class="nai-ai-result-index">
                                #${index + 1}
                            </div>

                            <span
                                class="nai-duplicate-badge"
                                data-result-duplicate-badge
                                title="이미 라이브러리에 Prompt 내용이 완전히 같은 컨셉이 있습니다."
                                ${duplicateItem ? '' : 'hidden'}
                            >중복</span>

                            <div class="nai-ai-extra-options">
                                <button
                                    type="button"
                                    class="nai-inline-note-toggle"
                                    data-result-note-toggle
                                    aria-expanded="${resultNoteOpen ? 'true' : 'false'}"
                                >메모 ${resultNoteOpen ? '▼' : '◀'}</button>
                                <button
                                    type="button"
                                    class="nai-ai-add-character"
                                    data-result-action="add-character"
                                    >+ 캐릭터프롬 추가</button>
                            </div>
                        </div>

                        <div
                            class="nai-inline-note-body"
                            data-result-note-body
                            ${resultNoteOpen ? '' : 'hidden'}
                        >
                            <textarea
                                class="nai-loader-textarea nai-note-editor"
                                data-result-field="note"
                                placeholder="설명 / 사용 팁 / 주의사항"
                            >${escapeHtml(item.note || '')}</textarea>
                        </div>

                        <div class="nai-loader-field">
                            <label class="nai-loader-label">
                                저장할 이름
                            </label>

                            <input
                                class="nai-loader-input"
                                type="text"
                                data-result-field="name"
                                value="${escapeHtml(item.suggestedName)}"
                            >
                        </div>

                        <div class="nai-loader-field nai-library-edit-category-field">
                            <label class="nai-loader-label">분류</label>
                            <div class="nai-library-card-category-row" aria-label="가져올 컨셉 분류">
                                ${renderAnalysisCategoryAssignment(item)}
                            </div>
                        </div>

                        <div
                            class="nai-analysis-prompt-editor"
                            data-result-prompt-editor
                        >
                            <div class="nai-analysis-prompt-tabs">
                                <button
                                    type="button"
                                    class="nai-analysis-prompt-tab active"
                                    data-analysis-prompt-tab="prompt"
                                >Base Prompt</button>
                                <button
                                    type="button"
                                    class="nai-analysis-prompt-tab"
                                    data-analysis-prompt-tab="negative"
                                >Undesired Content</button>
                            </div>

                            <div
                                class="nai-analysis-prompt-panel"
                                data-analysis-prompt-panel="prompt"
                            >
                                <textarea
                                    class="nai-loader-textarea"
                                    data-result-field="tags"
                                    placeholder="Base Prompt"
                                >${escapeHtml(item.tags || '')}</textarea>
                            </div>

                            <div
                                class="nai-analysis-prompt-panel"
                                data-analysis-prompt-panel="negative"
                                hidden
                            >
                                <textarea
                                    class="nai-loader-textarea"
                                    data-result-field="negativeTags"
                                    placeholder="Negative Prompt / Undesired Content"
                                >${escapeHtml(item.negativeTags || '')}</textarea>
                            </div>
                        </div>

                        ${characters.length ? `
                            <div class="nai-loader-label" style="margin-bottom:8px;">
                                Character Prompts
                            </div>

                            <div class="nai-character-group">
                                ${characters.map((character, characterIndex) => `
                                    <div
                                        class="nai-ai-character-block"
                                        data-result-character-index="${characterIndex}"
                                    >
                                        <div class="nai-ai-character-title-row">
                                            <div class="nai-character-title" style="margin-bottom:0;">
                                                ${escapeHtml(
                                                    character.name ||
                                                    `Character ${characterIndex + 1}`
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                class="nai-ai-character-remove"
                                                data-result-action="remove-character"
                                                title="이 Character Prompt 삭제"
                                                aria-label="이 Character Prompt 삭제"
                                            >×</button>
                                        </div>

                                        <div
                                            class="nai-analysis-prompt-editor"
                                            data-result-prompt-editor
                                            style="margin-bottom:0;"
                                        >
                                            <div class="nai-analysis-prompt-tabs">
                                                <button
                                                    type="button"
                                                    class="nai-analysis-prompt-tab active"
                                                    data-analysis-prompt-tab="prompt"
                                                >Prompt</button>
                                                <button
                                                    type="button"
                                                    class="nai-analysis-prompt-tab"
                                                    data-analysis-prompt-tab="negative"
                                                >Undesired Content</button>
                                            </div>

                                            <div
                                                class="nai-analysis-prompt-panel"
                                                data-analysis-prompt-panel="prompt"
                                            >
                                                <textarea
                                                    class="nai-loader-textarea"
                                                    data-result-character-field="prompt"
                                                    placeholder="Character ${characterIndex + 1} Prompt"
                                                >${escapeHtml(character.prompt || '')}</textarea>
                                            </div>

                                            <div
                                                class="nai-analysis-prompt-panel"
                                                data-analysis-prompt-panel="negative"
                                                hidden
                                            >
                                                <textarea
                                                    class="nai-loader-textarea"
                                                    data-result-character-field="negativePrompt"
                                                    placeholder="Character ${characterIndex + 1} Undesired Content"
                                                >${escapeHtml(character.negativePrompt || '')}</textarea>
                                            </div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}

                    </article>
                `;
            }).join('');

            requestAnimationFrame(() => {
                $$('#nai-ai-results .nai-loader-textarea').forEach(textarea => {
                    const panel = textarea.closest('[data-analysis-prompt-panel]');
                    if (panel?.hidden) return;
                    fitAnalysisTextarea(textarea);
                });
            });
        }

        function syncAnalysisResultsFromDom() {
            $$('#nai-ai-results [data-result-id]').forEach(card => {
                const id = card.dataset.resultId;
                const item = analysisResults.find(row => row.id === id);

                if (!item) return;

                item.selected =
                    !!card.querySelector('[data-result-field="selected"]')?.checked;

                item.suggestedName =
                    card.querySelector('[data-result-field="name"]')?.value.trim() ||
                    item.suggestedName;

                const baseField = card.querySelector(
                    '[data-result-field="tags"]'
                );

                const negativeField = card.querySelector(
                    '[data-result-field="negativeTags"]'
                );

                if (baseField) {
                    item.tags = baseField.value.trim();
                }

                if (negativeField) {
                    item.negativeTags = negativeField.value.trim();
                }

                const noteField = card.querySelector(
                    '[data-result-field="note"]'
                );
                if (noteField) {
                    item.note = noteField.value.trim();
                }

                item.categories = normalizeLibraryCategoryList(item.categories);

                const previousCharacters = normalizeCharacterRows(item.characters);
                const nextCharacters = [];

                card.querySelectorAll(
                    '[data-result-character-index]'
                ).forEach(characterCard => {
                    const characterIndex = Number(
                        characterCard.dataset.resultCharacterIndex
                    );
                    const previous = previousCharacters[characterIndex] || {};
                    const prompt = String(
                        characterCard.querySelector(
                            '[data-result-character-field="prompt"]'
                        )?.value || ''
                    ).trim();
                    const negativePrompt = String(
                        characterCard.querySelector(
                            '[data-result-character-field="negativePrompt"]'
                        )?.value || ''
                    ).trim();

                    nextCharacters.push({
                        name:
                            String(previous.name || '').trim() ||
                            `Character ${characterIndex + 1}`,
                        prompt,
                        negativePrompt,
                        ...(!prompt && !negativePrompt
                            ? { _analysisDraft: true }
                            : {})
                    });
                });

                item.characters = normalizeCharacterRows(nextCharacters);
            });
        }

        function refreshAnalysisDuplicateBadges() {
            $$('#nai-ai-results [data-result-id]').forEach(card => {
                const item = analysisResults.find(row => row.id === card.dataset.resultId);
                const badge = card.querySelector('[data-result-duplicate-badge]');
                if (!item || !badge) return;
                badge.hidden = !findLibraryExactDuplicate(item);
            });
        }

        async function handleConceptAction(button) {
            const card = button.closest('[data-concept-id]');

            if (!card) return;

            const id = card.dataset.conceptId;
            const action = button.dataset.conceptAction;
            const library = getLibrary();
            const index = library.findIndex(item => item.id === id);

            if (index < 0) return;

            const item = normalizeConceptRecord(library[index]);
            const status = $('#nai-library-status');


            if (action === 'use') {
                const result = await insertConceptIntoNovelAI(item);

                status.textContent = result.ok
                    ? `"${item.name}" 적용 완료` +
                      `${result.insertedPositive ? ' · Base Prompt' : ''}` +
                      `${result.insertedNegative ? ' · Main UC' : ''}` +
                      `${result.insertedCharacters ? ` · Character Prompt ${result.insertedCharacters}개` : ''}` +
                      `${result.insertedCharacterNegatives ? ` · Character UC ${result.insertedCharacterNegatives}개` : ''}`
                    : result.error;

                return;
            }

            if (action === 'copy') {
                const ok = await copyText(item.tags || '');

                status.textContent = ok
                    ? `"${item.name}" Base Prompt를 클립보드에 복사했습니다.`
                    : '클립보드 복사에 실패했습니다.';

                return;
            }

            if (action === 'copy-negative') {
                const ok = await copyText(item.negativeTags || '');

                status.textContent = ok
                    ? `"${item.name}" Undesired Content를 클립보드에 복사했습니다.`
                    : '클립보드 복사에 실패했습니다.';

                return;
            }

            if (action === 'share') {
                try {
                    const shareCode = createConceptShareCode(item);
                    const ok = await copyText(shareCode);
                    status.textContent = ok
                        ? `"${item.name}" 공유 코드를 클립보드에 복사했습니다.`
                        : '공유 코드 클립보드 복사에 실패했습니다.';
                } catch (error) {
                    status.textContent = `공유 코드 생성 실패: ${error?.message || String(error)}`;
                }
                return;
            }

            if (action === 'source') {
                if (item?.source?.url) {
                    window.open(
                        item.source.url,
                        '_blank',
                        'noopener,noreferrer'
                    );
                }

                return;
            }

            if (action === 'edit') {
                editingId = id;
                editingDraft = {
                    ...item,
                    characters: (item.characters || []).map(character => ({ ...character }))
                };
                renderLibrary();

                requestAnimationFrame(() => {
                    $('#nai-library-list [data-library-edit-card] [data-edit-field="name"]')?.focus();
                });
                return;
            }

            if (action === 'cancel-edit') {
                editingId = null;
                editingDraft = null;
                renderLibrary();
                return;
            }

            if (action === 'save-edit') {
                syncLibraryEditDraftFromDom();
                const draft = editingDraft || item;
                const nextName = String(draft.name || '').trim();
                const nextTags = String(draft.tags || '').trim();
                const nextNegativeTags = String(draft.negativeTags || '').trim();
                const nextNote = String(draft.note || '').trim();
                const sourceUrlRaw = String(draft?.source?.url || '').trim();
                const nextSourceUrl = normalizedExternalUrl(sourceUrlRaw);
                const cleanedCharacters = cleanLibraryEditCharacters(draft.characters);

                if (!nextName) {
                    status.textContent = '컨셉 이름을 입력해주세요.';
                    return;
                }

                if (!nextTags && !nextNegativeTags && !cleanedCharacters.length) {
                    status.textContent =
                        'Base / UC / Character Prompt 중 하나는 있어야 합니다.';
                    return;
                }

                if (sourceUrlRaw && !nextSourceUrl) {
                    status.textContent = '원본 링크는 http:// 또는 https:// 주소로 입력해주세요.';
                    return;
                }

                library[index] = {
                    ...item,
                    name: nextName,
                    tags: nextTags,
                    negativeTags: nextNegativeTags,
                    characters: cleanedCharacters,
                    note: nextNote,
                    source: {
                        ...(item.source || {}),
                        type: nextSourceUrl ? detectSourceType(nextSourceUrl) : 'Manual',
                        url: nextSourceUrl
                    },
                    updatedAt: Date.now()
                };

                saveLibrary(library);
                editingId = null;
                editingDraft = null;
                renderLibrary();
                status.textContent = `"${nextName}" 수정 완료.`;
                return;
            }

            if (action === 'delete') {
                const confirmed =
                    window.confirm(`"${item.name}" 컨셉을 삭제할까요?`);

                if (!confirmed) return;

                library.splice(index, 1);
                saveLibrary(library);

                if (editingId === id) {
                    editingId = null;
                }

                renderLibrary();

                status.textContent = `"${item.name}" 삭제 완료.`;
            }
        }

        function saveImportedConcept() {
            syncManualDraftFromDom();

            const name = String(manualDraft.name || '').trim();
            const tags = String(manualDraft.tags || '').trim();
            const negativeTags = String(manualDraft.negativeTags || '').trim();
            const note = String(manualDraft.note || '').trim();
            const sourceUrlRaw = String(manualDraft.sourceUrl || '').trim();
            const sourceUrl = normalizedExternalUrl(sourceUrlRaw);
            const characters = cleanLibraryEditCharacters(manualDraft.characters);
            const status = $('#nai-manual-status');

            if (!name) {
                status.textContent = '저장할 컨셉 이름을 입력해주세요.';
                return;
            }

            if (!tags && !negativeTags && !characters.length) {
                status.textContent =
                    'Base / UC / Character Prompt 중 하나는 있어야 합니다.';
                return;
            }

            if (sourceUrlRaw && !sourceUrl) {
                status.textContent = '원본 링크는 http:// 또는 https:// 주소로 입력해주세요.';
                return;
            }

            const library = getLibrary();
            const now = Date.now();

            library.unshift({
                id: createId(),
                name,
                tags,
                negativeTags,
                characters,
                note,
                categories: normalizeLibraryCategoryList(manualDraft.categories),
                source: {
                    type: sourceUrl ? detectSourceType(sourceUrl) : 'Manual',
                    url: sourceUrl
                },
                createdAt: now,
                updatedAt: now
            });

            saveLibrary(library);

            manualDraft = {
                name: '',
                note: '',
                sourceUrl: '',
                tags: '',
                negativeTags: '',
                characters: [],
                categories: []
            };
            $('#nai-manual-editor-root').innerHTML = '';
            setCreatePanelOpen('library', false);

            status.textContent = '';
            $('#nai-library-status').textContent =
                `"${name}" 컨셉을 라이브러리에 저장했습니다.`;

            renderLibrary();
        }

        function syncShareImportDraftFromDom() {
            if (!shareImportDraft) return;
            const preview = $('#nai-share-import-preview');
            if (!preview) return;

            if (shareImportDraft.kind === 'resource') {
                shareImportDraft = {
                    ...shareImportDraft,
                    name: String(preview.querySelector('[data-share-preview-field="name"]')?.value || '').trim(),
                    url: String(preview.querySelector('[data-share-preview-field="url"]')?.value || '').trim(),
                    note: String(preview.querySelector('[data-share-preview-field="note"]')?.value || '').trim()
                };
                return;
            }

            if (shareImportDraft.kind === 'memo') {
                shareImportDraft = {
                    ...shareImportDraft,
                    title: String(preview.querySelector('[data-share-preview-field="title"]')?.value || '').trim(),
                    content: String(preview.querySelector('[data-share-preview-field="content"]')?.value || '').trim()
                };
            }
        }

        function renderShareImportCategoryAssignment(kind, selectedCategories) {
            const categories = kind === 'resource'
                ? getResourceCategories()
                : getMemoCategories();
            if (!categories.length) {
                return '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
            }

            const selected = new Set(normalizeLibraryCategoryList(selectedCategories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-share-preview-category="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderShareImportPreview() {
            const wrap = $('#nai-share-import-preview');
            if (!wrap) return;

            if (!shareImportDraft) {
                wrap.hidden = true;
                wrap.innerHTML = '';
                return;
            }

            wrap.hidden = false;
            const draft = shareImportDraft;

            if (draft.kind === 'resource') {
                wrap.innerHTML = `
                    <div class="nai-import-result" data-share-preview-kind="resource">
                        <div class="nai-loader-section-title">자료실 공유 코드 미리보기</div>
                        <div class="nai-duplicate-warning" data-share-preview-duplicate-warning hidden></div>
                        <div class="nai-loader-field">
                            <label class="nai-loader-label">이름</label>
                            <input class="nai-loader-input" data-share-preview-field="name" value="${escapeHtml(draft.name || '')}">
                        </div>
                        <div class="nai-loader-field nai-library-edit-category-field">
                            <label class="nai-loader-label">분류</label>
                            <div class="nai-library-card-category-row" aria-label="가져올 자료 분류">
                                ${renderShareImportCategoryAssignment('resource', draft.categories)}
                            </div>
                        </div>
                        <div class="nai-loader-field">
                            <label class="nai-loader-label">링크</label>
                            <input class="nai-loader-input" data-share-preview-field="url" type="url" value="${escapeHtml(draft.url || '')}">
                        </div>
                        <div class="nai-loader-field" style="margin-bottom:0;">
                            <label class="nai-loader-label">메모 <span class="nai-loader-muted">(선택)</span></label>
                            <textarea class="nai-loader-textarea" data-share-preview-field="note">${escapeHtml(draft.note || '')}</textarea>
                        </div>
                        <div class="nai-edit-footer-actions" style="margin-top:10px;">
                            <button type="button" class="nai-loader-action" data-share-preview-action="cancel">취소</button>
                            <button type="button" class="nai-loader-action primary" data-share-preview-action="save">자료실에 저장</button>
                        </div>
                    </div>
                `;
                refreshShareImportDuplicateWarning();
                return;
            }

            wrap.innerHTML = `
                <div class="nai-import-result" data-share-preview-kind="memo">
                    <div class="nai-loader-section-title">메모 공유 코드 미리보기</div>
                    <div class="nai-duplicate-warning" data-share-preview-duplicate-warning hidden></div>
                    <div class="nai-loader-field">
                        <label class="nai-loader-label">제목 <span class="nai-loader-muted">(선택)</span></label>
                        <input class="nai-loader-input" data-share-preview-field="title" value="${escapeHtml(draft.title || '')}">
                    </div>
                    <div class="nai-loader-field nai-library-edit-category-field">
                        <label class="nai-loader-label">분류</label>
                        <div class="nai-library-card-category-row" aria-label="가져올 메모 분류">
                            ${renderShareImportCategoryAssignment('memo', draft.categories)}
                        </div>
                    </div>
                    <div class="nai-loader-field" style="margin-bottom:0;">
                        <label class="nai-loader-label">내용</label>
                        <textarea class="nai-loader-textarea" data-share-preview-field="content">${escapeHtml(draft.content || '')}</textarea>
                    </div>
                    <div class="nai-edit-footer-actions" style="margin-top:10px;">
                        <button type="button" class="nai-loader-action" data-share-preview-action="cancel">취소</button>
                        <button type="button" class="nai-loader-action primary" data-share-preview-action="save">메모에 저장</button>
                    </div>
                </div>
            `;
            refreshShareImportDuplicateWarning();
        }

        function refreshShareImportDuplicateWarning() {
            const preview = $('#nai-share-import-preview');
            const warning = preview?.querySelector('[data-share-preview-duplicate-warning]');
            const saveButton = preview?.querySelector('[data-share-preview-action="save"]');
            if (!shareImportDraft || !warning) return;

            let duplicate = null;
            let message = '';

            if (shareImportDraft.kind === 'resource') {
                duplicate = findResourceExactDuplicate(shareImportDraft.url || '');
                message = duplicate
                    ? '중복 · 자료실에 완전히 같은 링크가 이미 저장되어 있습니다.'
                    : '';
            } else if (shareImportDraft.kind === 'memo') {
                duplicate = findMemoExactDuplicate(shareImportDraft.content || '');
                message = duplicate
                    ? '중복 · 메모에 내용이 완전히 같은 메모가 이미 저장되어 있습니다.'
                    : '';
            }

            warning.textContent = message;
            warning.hidden = !duplicate;
            if (saveButton) {
                saveButton.disabled = !!duplicate;
                saveButton.title = duplicate ? '중복 내용을 수정하면 저장할 수 있습니다.' : '';
            }
        }

        function clearShareImportPreview() {
            shareImportDraft = null;
            renderShareImportPreview();
        }

        function saveShareImportPreview() {
            if (!shareImportDraft) return;
            syncShareImportDraftFromDom();
            const input = $('#nai-import-url');
            const status = $('#nai-import-status');
            const now = Date.now();

            if (shareImportDraft.kind === 'resource') {
                const url = normalizedExternalUrl(shareImportDraft.url || '');
                if (!url) {
                    status.textContent = '자료 링크에는 http:// 또는 https:// 주소를 입력해주세요.';
                    return;
                }

                const duplicate = findResourceExactDuplicate(url);
                if (duplicate) {
                    status.textContent = '';
                    refreshShareImportDuplicateWarning();
                    showToast('중복 자료입니다. 같은 링크가 이미 자료실에 있습니다.', 'error');
                    return;
                }

                const name = String(shareImportDraft.name || '').trim() || fallbackResourceName(url);
                const resources = getResources();
                resources.unshift({
                    id: createId(),
                    name,
                    url,
                    note: String(shareImportDraft.note || '').trim(),
                    categories: normalizeLibraryCategoryList(shareImportDraft.categories),
                    createdAt: now,
                    updatedAt: now
                });
                saveResources(resources);
                if (input) input.value = '';
                clearShareImportPreview();
                status.textContent = '';
                showToast(`"${name}" 자료를 자료실에 저장했습니다.`);
                switchTab('resources');
                return;
            }

            const content = String(shareImportDraft.content || '').trim();
            if (!content) {
                status.textContent = '메모 내용을 입력해주세요.';
                return;
            }

            const duplicate = findMemoExactDuplicate(content);
            if (duplicate) {
                status.textContent = '';
                refreshShareImportDuplicateWarning();
                showToast('중복 메모입니다. 내용이 완전히 같은 메모가 이미 있습니다.', 'error');
                return;
            }

            const title = String(shareImportDraft.title || '').trim();
            const memos = getMemos();
            memos.unshift({
                id: createId(),
                title,
                content,
                categories: normalizeLibraryCategoryList(shareImportDraft.categories),
                createdAt: now,
                updatedAt: now
            });
            saveMemos(memos);
            if (input) input.value = '';
            clearShareImportPreview();
            status.textContent = '';
            showToast(title
                ? `"${title}" 메모를 저장했습니다.`
                : '메모를 저장했습니다.');
            switchTab('memos');
        }

        function loadShareCodeFromImport() {
            const input = $('#nai-import-url');
            const status = $('#nai-import-status');
            const raw = String(input?.value || '').trim();

            if (isAnalyzing) {
                status.textContent = 'URL 분석 중에는 공유 코드를 불러올 수 없습니다. 분석이 끝난 뒤 다시 눌러주세요.';
                return;
            }

            if (!raw) {
                status.textContent = '공유 코드를 입력해주세요.';
                return;
            }

            try {
                const payload = parseShareCodePayload(raw);

                if (payload.kind === 'resource') {
                    const resource = parseResourceShareCode(raw);
                    shareImportDraft = {
                        kind: 'resource',
                        name: resource.name,
                        url: resource.url,
                        note: resource.note,
                        categories: []
                    };
                    analysisResults = [];
                    analysisMeta = null;
                    renderAnalysisResults();
                    renderShareImportPreview();
                    status.textContent = '자료실 공유 코드를 불러왔습니다. 내용을 수정한 뒤 자료실에 저장을 눌러주세요.';
                    return;
                }

                if (payload.kind === 'memo') {
                    const memo = parseMemoShareCode(raw);
                    shareImportDraft = {
                        kind: 'memo',
                        title: memo.title,
                        content: memo.content,
                        categories: []
                    };
                    analysisResults = [];
                    analysisMeta = null;
                    renderAnalysisResults();
                    renderShareImportPreview();
                    status.textContent = '메모 공유 코드를 불러왔습니다. 내용을 수정한 뒤 메모에 저장을 눌러주세요.';
                    return;
                }

                clearShareImportPreview();
                const concept = parseConceptShareCode(raw);

                analysisResultUnread = false;
                analysisUrl = '';
                analysisResults = [{
                    id: createId(),
                    selected: true,
                    suggestedName: concept.suggestedName,
                    sectionLabel: '',
                    tags: concept.tags,
                    negativeTags: concept.negativeTags,
                    characters: concept.characters,
                    note: concept.note,
                    sourceUrl: concept.sourceUrl,
                    sourcePageTitle: '',
                    _noteOpen: !!concept.note
                }];
                analysisMeta = {
                    method: 'share-code',
                    pageTitle: '확프 공유 코드'
                };
                analysisStatusText = '컨셉 공유 코드 1개를 불러왔습니다. 내용을 확인한 뒤 선택 항목 저장을 눌러주세요.';

                renderAnalysisResults();
                setGlobalAnalysisStatus(analysisStatusText);
                syncGlobalAnalyzeUi();
            } catch (error) {
                status.textContent = `공유 코드 불러오기 실패: ${error?.message || String(error)}`;
            }
        }

        function saveSelectedAnalysisResults() {
            syncAnalysisResultsFromDom();

            const url = normalizedExternalUrl($('#nai-import-url').value.trim());
            const selected = analysisResults.filter(item => item.selected);
            const status = $('#nai-import-status');

            if (!selected.length) {
                status.textContent =
                    '저장할 Prompt 세트를 하나 이상 선택해주세요.';
                return;
            }

            const invalid = selected.find(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const hasNegative =
                    !!String(item.negativeTags || '').trim();
                const hasCharacterContent = (item.characters || []).some(character =>
                    !!String(character?.prompt || '').trim() ||
                    !!String(character?.negativePrompt || '').trim()
                );

                return (
                    !String(item.suggestedName || '').trim() ||
                    (
                        !String(item.tags || '').trim() &&
                        !hasNegative &&
                        !hasCharacterContent
                    )
                );
            });

            if (invalid) {
                status.textContent =
                    '선택한 항목의 이름/Prompt를 확인해주세요.';
                return;
            }

            const duplicateSelected = selected.filter(item =>
                !!findLibraryExactDuplicate(item)
            );
            if (duplicateSelected.length) {
                refreshAnalysisDuplicateBadges();
                status.textContent = '';
                showToast(
                    duplicateSelected.length === 1
                        ? '중복 Prompt가 있습니다. 중복 표시된 항목을 수정하거나 선택 해제해주세요.'
                        : `중복 Prompt가 ${duplicateSelected.length}개 있습니다. 수정하거나 선택 해제해주세요.`,
                    'error'
                );
                return;
            }

            const library = getLibrary();
            const now = Date.now();

            const newItems = selected.map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const characters = normalizeCharacterRows(item.characters)
                    .map(character => ({
                        name: String(character.name || '').trim(),
                        prompt: String(character.prompt || '').trim(),
                        negativePrompt: String(character.negativePrompt || '').trim()
                    }))
                    .filter(character => character.prompt || character.negativePrompt);

                return {
                    id: createId(),
                    name: String(item.suggestedName || '').trim(),
                    tags: String(item.tags || '').trim(),
                    negativeTags: String(item.negativeTags || '').trim(),
                    characters,
                    note: String(item.note || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    source: (() => {
                        const sourceUrl = normalizedExternalUrl(item.sourceUrl || '') || url;
                        const isShareCode = analysisMeta?.method === 'share-code';
                        return {
                            type: sourceUrl
                                ? detectSourceType(sourceUrl)
                                : (isShareCode ? 'ShareCode' : 'Unknown'),
                            url: sourceUrl,
                            rootUrl: isShareCode ? '' : url,
                            provider: isShareCode ? '' : getSettings().provider,
                            importMethod: analysisMeta?.method || '',
                            pageTitle: item.sourcePageTitle || ''
                        };
                    })(),
                    createdAt: now,
                    updatedAt: now
                };
            });

            saveLibrary([...newItems, ...library]);

            const savedIds = new Set(selected.map(item => item.id));

            analysisResults = analysisResults.filter(
                item => !savedIds.has(item.id)
            );

            status.textContent =
                `${newItems.length}개 Prompt 세트를 라이브러리에 저장했습니다.`;

            renderAnalysisResults();
            renderLibrary();
        }

        async function runAnalyze() {
            if (isAnalyzing) {
                setGlobalAnalysisStatus(
                    analysisStatusText || '이미 백그라운드에서 분석 중입니다.'
                );
                syncGlobalAnalyzeUi();
                return;
            }

            const urlInput = $('#nai-import-url');
            const url = String(urlInput?.value || '').trim();

            if (!url) {
                setGlobalAnalysisStatus('먼저 URL을 입력해주세요.');
                return;
            }

            if (url.startsWith(SHARE_CODE_PREFIX)) {
                setGlobalAnalysisStatus('공유 코드는 왼쪽의 공유 코드 불러오기 버튼을 눌러주세요.');
                return;
            }

            if (!normalizedExternalUrl(url)) {
                setGlobalAnalysisStatus('URL 가져오기에는 http:// 또는 https:// 주소를 입력해주세요.');
                return;
            }

            const settings = getSettings();
            const settingsError = validateSettings(settings);

            if (settingsError) {
                setGlobalAnalysisStatus(`설정 필요: ${settingsError}`);
                switchTab('settings');
                return;
            }

            clearShareImportPreview();

            isAnalyzing = true;
            analysisResultUnread = false;
            analysisUrl = url;
            analysisResults = [];
            analysisMeta = null;
            setGlobalAnalysisStatus(
                '분석 시작 · 확프창을 닫아도 백그라운드에서 계속됩니다.'
            );
            notifyGlobalAnalysisState();
            renderAnalysisResults();

            let analysisSucceeded = false;

            try {
                const result = await analyzeSharedUrl(
                    url,
                    settings,
                    message => {
                        setGlobalAnalysisStatus(message);
                        syncGlobalAnalyzeUi();
                    }
                );

                analysisResults = Array.isArray(result?.concepts)
                    ? result.concepts
                    : [];
                analysisMeta = result || null;

                renderAnalysisResults();

                setGlobalAnalysisStatus(
                    String(result.method || '').startsWith('notion')
                        ? `Notion ${result.pagesVisited}개 페이지를 훑어서 ${result.concepts.length}개 Prompt 세트를 찾았습니다.${result.errors ? ` (${result.errors}개 항목은 읽기 실패)` : ''}`
                        : `${result.concepts.length}개 Prompt 세트를 찾았습니다. 이름/Prompt를 확인하고 저장하세요.`
                );
                analysisSucceeded = true;
                notifyGlobalAnalysisState();
            } catch (error) {
                setGlobalAnalysisStatus(
                    `분석 실패:\n${error?.message || String(error)}`
                );
                notifyGlobalAnalysisState();
            } finally {
                isAnalyzing = false;
                notifyGlobalAnalysisState();
                if (analysisSucceeded) {
                    triggerAnalysisCompletionAnimation();
                }
            }
        }

        async function runConnectionTest() {
            if (isTesting) return;

            const status = $('#nai-settings-status');
            const button = $('[data-action="test-settings"]');
            const settings = collectSettingsFromForm();
            const error = validateSettings(settings);

            if (error) {
                status.textContent = error;
                return;
            }

            saveSettings(settings);

            isTesting = true;
            button.disabled = true;
            button.innerHTML =
                '<span class="nai-loading">테스트 중</span>';

            try {
                const result = await testProviderConnection(settings);
                status.textContent = result;
            } catch (testError) {
                status.textContent =
                    `연결 실패: ${testError?.message || String(testError)}`;
            } finally {
                isTesting = false;
                button.disabled = false;
                button.textContent = '연결 테스트';
            }
        }

        $$('.nai-loader-tab').forEach(button => {
            button.addEventListener('click', () => {
                switchTab(button.dataset.tab);
            });
        });

        $$('.nai-provider-button').forEach(button => {
            button.addEventListener('click', () => {
                currentProvider = button.dataset.provider;
                updateProviderUI();
            });
        });

        $$('[data-create-toggle]').forEach(button => {
            button.addEventListener('click', () => {
                const kind = button.dataset.createToggle;
                const isOpen = button.getAttribute('aria-expanded') === 'true';

                if (kind === 'library') {
                    if (isOpen) syncManualDraftFromDom();
                    setCreatePanelOpen('library', !isOpen);
                    if (!isOpen) {
                        requestAnimationFrame(() => {
                            $('#nai-manual-editor-root [data-manual-field="name"]')?.focus();
                        });
                    }
                    return;
                }

                if (kind === 'resources') {
                    setCreatePanelOpen('resources', !isOpen);
                    if (!isOpen) requestAnimationFrame(() => $('#nai-resource-name')?.focus());
                    return;
                }

                if (kind === 'memos') {
                    setCreatePanelOpen('memos', !isOpen);
                    if (!isOpen) requestAnimationFrame(() => $('#nai-memo-title')?.focus());
                }
            });
        });

        function bindInfoCategoryBar(kind) {
            const config = getInfoCategoryConfig(kind);
            const bar = $(config.bar);
            if (!bar) return;

            bar.addEventListener('click', handleInfoCategoryBarClick);
            bar.addEventListener('change', event => {
                const input = event.target.closest('[data-info-category-rename]');
                if (!input || input.dataset.infoCategoryScope !== kind) return;
                renameInfoCategory(kind, input.dataset.infoCategoryRename, input.value);
            });
            bar.addEventListener('keydown', event => {
                const input = event.target.closest('[data-info-category-rename]');
                if (!input || input.dataset.infoCategoryScope !== kind) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.blur();
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    input.value = input.dataset.infoCategoryRename || '';
                    input.blur();
                }
            });
        }

        bindInfoCategoryBar('resources');
        bindInfoCategoryBar('memos');

        $('#nai-resource-search').addEventListener('input', renderResources);

        function getResourceDragCards(list) {
            return [...list.querySelectorAll('[data-resource-id]')];
        }

        function finishResourceDrag({ cancel = false } = {}) {
            const state = resourceDragState;
            if (!state) return;

            const { list, card, handle, pointerId, moved } = state;
            try {
                if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
            } catch (_) {}

            handle.classList.remove('dragging');
            card.classList.remove('nai-resource-dragging');
            list.classList.remove('nai-resource-drag-active');
            resourceDragState = null;

            if (moved) {
                resourceDragSuppressClickUntil = Date.now() + 550;
            }

            if (cancel) {
                renderResources();
                return;
            }

            if (!moved) return;
            const orderedIds = getResourceDragCards(list)
                .map(node => node.dataset.resourceId)
                .filter(Boolean);
            saveVisibleResourceOrder(orderedIds);
            renderResources();
        }

        function handleResourceDragMove(event) {
            const state = resourceDragState;
            if (!state || event.pointerId !== state.pointerId) return;

            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if (!state.moved && Math.hypot(dx, dy) < 5) return;

            if (!state.moved) {
                state.moved = true;
                state.list.classList.add('nai-resource-drag-active');
                state.card.classList.add('nai-resource-dragging');
                state.handle.classList.add('dragging');
            }

            event.preventDefault();

            const candidates = document.elementsFromPoint(event.clientX, event.clientY)
                .map(node => node.closest?.('[data-resource-id]'))
                .filter(Boolean);
            const target = candidates.find(node => node !== state.card && node.parentElement === state.list);
            if (!target) return;

            const rect = target.getBoundingClientRect();
            const nearSameRow = Math.abs(event.clientY - (rect.top + rect.height / 2)) <= rect.height * 0.34;
            const before = nearSameRow
                ? event.clientX < rect.left + rect.width / 2
                : event.clientY < rect.top + rect.height / 2;

            if (before) {
                if (state.card.nextElementSibling !== target) {
                    state.list.insertBefore(state.card, target);
                }
            } else if (target.nextElementSibling !== state.card) {
                state.list.insertBefore(state.card, target.nextElementSibling);
            }
        }

        function startResourceDrag(event) {
            const handle = event.target.closest('[data-resource-drag-handle]');
            if (!handle || event.button !== 0) return;
            const card = handle.closest('.nai-resource-card[data-resource-id]');
            const list = handle.closest('#nai-resource-list');
            if (!card || !list) return;

            event.preventDefault();
            event.stopPropagation();
            resourceDragState = {
                list,
                card,
                handle,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false
            };

            try {
                handle.setPointerCapture?.(event.pointerId);
            } catch (_) {}
        }

        function openResourceCard(card) {
            if (!card || card.classList.contains('nai-info-edit-card')) return false;
            const id = card.dataset.resourceId;
            if (!id) return false;
            const item = getResources()
                .map(normalizeResourceRecord)
                .find(resource => resource.id === id);
            const url = normalizedExternalUrl(item?.url);
            if (!url) return false;
            window.open(url, '_blank', 'noopener,noreferrer');
            return true;
        }

        $('#nai-resource-list').addEventListener('pointerdown', startResourceDrag);
        $('#nai-resource-list').addEventListener('pointermove', handleResourceDragMove);
        $('#nai-resource-list').addEventListener('pointerup', event => {
            if (resourceDragState && event.pointerId === resourceDragState.pointerId) {
                finishResourceDrag();
            }
        });
        $('#nai-resource-list').addEventListener('pointercancel', event => {
            if (resourceDragState && event.pointerId === resourceDragState.pointerId) {
                finishResourceDrag({ cancel: true });
            }
        });

        $('#nai-resource-list').addEventListener('click', event => {
            if (Date.now() < resourceDragSuppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const categoryButton = event.target.closest('[data-info-category-assign][data-info-category-scope="resources"]');
            if (categoryButton) {
                handleInfoCategoryAssignment(categoryButton);
                return;
            }

            const button = event.target.closest('[data-resource-action]');
            if (button) {
                handleResourceAction(button);
                return;
            }

            const card = event.target.closest('.nai-resource-card[data-resource-id]');
            if (!card) return;

            /* 삭제/수정/순서 버튼이 있는 조작 구간은 카드 링크에서 제외. */
            if (event.target.closest('[data-resource-card-actions], button, input, textarea, select, a')) {
                return;
            }
            openResourceCard(card);
        });

        $('#nai-resource-list').addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const card = event.target.closest('.nai-resource-card[data-resource-id]');
            if (!card || event.target !== card) return;
            event.preventDefault();
            openResourceCard(card);
        });
        $('#nai-resource-create-wrap').addEventListener('click', event => {
            const categoryButton = event.target.closest('[data-resource-create-category]');
            if (categoryButton) {
                const name = normalizeLibraryCategoryName(categoryButton.dataset.resourceCreateCategory);
                if (!name) return;
                if (resourceCreateCategories.has(name)) resourceCreateCategories.delete(name);
                else resourceCreateCategories.add(name);
                renderResourceCreateCategoryAssignment();
                return;
            }

            const button = event.target.closest('[data-resource-action]');
            if (button) handleResourceAction(button);
        });

        $('#nai-memo-search').addEventListener('input', renderMemos);

        function getMemoDragCards(list) {
            return [...list.querySelectorAll('.nai-memo-card[data-memo-id]')];
        }

        function finishMemoDrag({ cancel = false } = {}) {
            const state = memoDragState;
            if (!state) return;

            const { list, card, handle, pointerId, moved } = state;
            try {
                if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
            } catch (_) {}

            handle.classList.remove('dragging');
            card.classList.remove('nai-memo-dragging');
            list.classList.remove('nai-memo-drag-active');
            memoDragState = null;

            if (moved) memoDragSuppressClickUntil = Date.now() + 550;

            if (cancel) {
                renderMemos();
                return;
            }

            if (!moved) return;
            const orderedIds = getMemoDragCards(list)
                .map(node => node.dataset.memoId)
                .filter(Boolean);
            saveVisibleMemoOrder(orderedIds);
            renderMemos();
        }

        function handleMemoDragMove(event) {
            const state = memoDragState;
            if (!state || event.pointerId !== state.pointerId) return;

            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if (!state.moved && Math.hypot(dx, dy) < 5) return;

            if (!state.moved) {
                state.moved = true;
                state.list.classList.add('nai-memo-drag-active');
                state.card.classList.add('nai-memo-dragging');
                state.handle.classList.add('dragging');
            }

            event.preventDefault();

            const candidates = document.elementsFromPoint(event.clientX, event.clientY)
                .map(node => node.closest?.('.nai-memo-card[data-memo-id]'))
                .filter(Boolean);
            const target = candidates.find(node => node !== state.card && node.parentElement === state.list);
            if (!target) return;

            const rect = target.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (before) {
                if (state.card.nextElementSibling !== target) state.list.insertBefore(state.card, target);
            } else if (target.nextElementSibling !== state.card) {
                state.list.insertBefore(state.card, target.nextElementSibling);
            }
        }

        function startMemoDrag(event) {
            const handle = event.target.closest('[data-memo-drag-handle]');
            if (!handle || event.button !== 0) return;
            const card = handle.closest('.nai-memo-card[data-memo-id]');
            const list = handle.closest('#nai-memo-list');
            if (!card || !list) return;

            event.preventDefault();
            event.stopPropagation();
            memoDragState = {
                list,
                card,
                handle,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false
            };

            try {
                handle.setPointerCapture?.(event.pointerId);
            } catch (_) {}
        }

        $('#nai-memo-list').addEventListener('pointerdown', startMemoDrag);
        $('#nai-memo-list').addEventListener('pointermove', handleMemoDragMove);
        $('#nai-memo-list').addEventListener('pointerup', event => {
            if (memoDragState && event.pointerId === memoDragState.pointerId) finishMemoDrag();
        });
        $('#nai-memo-list').addEventListener('pointercancel', event => {
            if (memoDragState && event.pointerId === memoDragState.pointerId) {
                finishMemoDrag({ cancel: true });
            }
        });

        $('#nai-memo-list').addEventListener('click', event => {
            if (Date.now() < memoDragSuppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const categoryButton = event.target.closest('[data-info-category-assign][data-info-category-scope="memos"]');
            if (categoryButton) {
                handleInfoCategoryAssignment(categoryButton);
                return;
            }
            const button = event.target.closest('[data-memo-action]');
            if (button) handleMemoAction(button);
        });
        $('#nai-memo-create-wrap').addEventListener('click', event => {
            const categoryButton = event.target.closest('[data-memo-create-category]');
            if (categoryButton) {
                const name = normalizeLibraryCategoryName(categoryButton.dataset.memoCreateCategory);
                if (!name) return;
                if (memoCreateCategories.has(name)) memoCreateCategories.delete(name);
                else memoCreateCategories.add(name);
                renderMemoCreateCategoryAssignment();
                return;
            }

            const button = event.target.closest('[data-memo-action]');
            if (button) handleMemoAction(button);
        });

        $('[data-action="close"]').addEventListener(
            'click',
            () => overlay.remove()
        );

        function setAllAnalysisSelection(selected) {
            syncAnalysisResultsFromDom();

            analysisResults.forEach(item => {
                item.selected = !!selected;
            });

            $$('#nai-ai-results [data-result-field="selected"]').forEach(checkbox => {
                checkbox.checked = !!selected;
            });
        }

        $('[data-action="select-all-results"]').addEventListener(
            'click',
            () => setAllAnalysisSelection(true)
        );

        $('[data-action="clear-all-results"]').addEventListener(
            'click',
            () => setAllAnalysisSelection(false)
        );

        $('[data-action="save-selected"]').addEventListener(
            'click',
            saveSelectedAnalysisResults
        );

        $('#nai-share-import-preview').addEventListener('input', event => {
            if (!event.target.closest('[data-share-preview-field]')) return;
            syncShareImportDraftFromDom();
            refreshShareImportDuplicateWarning();
        });

        $('#nai-share-import-preview').addEventListener('click', event => {
            const categoryButton = event.target.closest('[data-share-preview-category]');
            if (categoryButton && shareImportDraft) {
                syncShareImportDraftFromDom();
                const name = normalizeLibraryCategoryName(categoryButton.dataset.sharePreviewCategory);
                if (!name) return;
                const selected = new Set(normalizeLibraryCategoryList(shareImportDraft.categories));
                if (selected.has(name)) selected.delete(name);
                else selected.add(name);
                shareImportDraft = {
                    ...shareImportDraft,
                    categories: [...selected]
                };
                renderShareImportPreview();
                return;
            }

            const action = event.target.closest('[data-share-preview-action]')?.dataset.sharePreviewAction;
            if (action === 'cancel') {
                clearShareImportPreview();
                $('#nai-import-status').textContent = '';
                return;
            }
            if (action === 'save') saveShareImportPreview();
        });

        $('[data-action="load-share-code"]').addEventListener(
            'click',
            loadShareCodeFromImport
        );

        $('[data-action="analyze"]').addEventListener(
            'click',
            runAnalyze
        );

        $('[data-action="reset-archive"]').addEventListener(
            'click',
            () => {
                const confirmed = window.confirm(
                    '정말 전체 초기화할까요?\n\n' +
                    '라이브러리 · 자료실 · 메모와 각 분류가 모두 삭제됩니다.\n' +
                    'API 키와 AI 연결 설정은 유지됩니다.\n\n' +
                    '필요한 데이터는 백업 파일로 받아두셨나요?\n\n' +
                    '[확인]을 누르면 즉시 삭제됩니다.'
                );
                if (!confirmed) return;

                saveLibrary([]);
                saveLibraryCategories([]);
                saveResources([]);
                saveResourceCategories([]);
                saveMemos([]);
                saveMemoCategories([]);

                activeLibraryCategories.clear();
                activeResourceCategories.clear();
                activeMemoCategories.clear();
                expandedLibraryCards.clear();
                expandedLibraryNotes.clear();

                editingId = null;
                editingDraft = null;
                resourceEditingId = null;
                resourceEditingDraft = null;
                memoEditingId = null;
                memoEditingDraft = null;
                libraryCreateOpen = false;
                resourceCreateOpen = false;
                memoCreateOpen = false;
                resourceCreateCategories.clear();
                memoCreateCategories.clear();
                manualDraft = {
                    name: '',
                    note: '',
                    sourceUrl: '',
                    tags: '',
                    negativeTags: '',
                    characters: [],
                    categories: []
                };

                visibleLibraryIds = [];
                visibleResourceIds = [];
                visibleMemoIds = [];
                libraryDragState = null;
                resourceDragState = null;
                memoDragState = null;

                backupItemSelection.library.clear();
                backupItemSelection.resources.clear();
                backupItemSelection.memos.clear();
                backupSelectionInitialized = false;
                restoreDraft = null;

                const restorePreview = $('#nai-restore-preview');
                if (restorePreview) {
                    restorePreview.hidden = true;
                    restorePreview.innerHTML = '';
                }

                renderLibrary();
                renderResources();
                renderMemos();
                renderBackupSelection();
                showToast('라이브러리 · 자료실 · 메모를 전체 초기화했습니다. API 설정은 유지됩니다.');
            }
        );

        $('[data-action="save-settings"]').addEventListener(
            'click',
            () => {
                const settings = collectSettingsFromForm();
                const error = validateSettings(settings);

                if (error) {
                    $('#nai-settings-status').textContent = error;
                    return;
                }

                saveSettings(settings);

                $('#nai-settings-status').textContent =
                    `${providerLabel(settings.provider)} 설정을 저장했습니다.`;
            }
        );

        $('[data-action="test-settings"]').addEventListener(
            'click',
            runConnectionTest
        );

        $('#nai-manual-editor-root').addEventListener(
            'click',
            event => {
                const noteToggle = event.target.closest('[data-manual-note-toggle]');
                if (noteToggle) {
                    syncManualDraftFromDom();
                    const body = $('#nai-manual-editor-root').querySelector('[data-manual-note-body]');
                    const nextOpen = noteToggle.getAttribute('aria-expanded') !== 'true';
                    manualDraft._noteOpen = nextOpen;
                    noteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    noteToggle.textContent = `메모 ${nextOpen ? '▼' : '◀'}`;
                    if (body) body.hidden = !nextOpen;
                    if (nextOpen) {
                        requestAnimationFrame(() => {
                            const textarea = body?.querySelector('[data-manual-field="note"]');
                            if (textarea) fitAnalysisTextarea(textarea);
                        });
                    }
                    return;
                }

                const categoryButton = event.target.closest('[data-manual-category-assign]');
                if (categoryButton) {
                    syncManualDraftFromDom();
                    const name = normalizeLibraryCategoryName(categoryButton.dataset.manualCategoryAssign);
                    if (!name) return;
                    const selected = new Set(normalizeLibraryCategoryList(manualDraft.categories));
                    if (selected.has(name)) selected.delete(name);
                    else selected.add(name);
                    manualDraft.categories = normalizeLibraryCategoryList([...selected]);
                    renderManualCreateCategoryAssignment();
                    return;
                }

                const tabButton = event.target.closest('[data-analysis-prompt-tab]');
                if (tabButton) {
                    activateAnalysisPromptTab(
                        tabButton.closest('.nai-analysis-prompt-editor'),
                        tabButton.dataset.analysisPromptTab
                    );
                    return;
                }

                const action = event.target.closest('[data-manual-edit-action]');
                if (action) {
                    syncManualDraftFromDom();

                    if (action.dataset.manualEditAction === 'add-character') {
                        const characters = Array.isArray(manualDraft.characters)
                            ? [...manualDraft.characters]
                            : [];
                        characters.push({
                            name: `Character ${characters.length + 1}`,
                            prompt: '',
                            negativePrompt: '',
                            _analysisDraft: true
                        });
                        manualDraft.characters = characters;
                        renderManualAddEditor();
                        requestAnimationFrame(() => {
                            const prompts = [...$('#nai-manual-editor-root').querySelectorAll(
                                '[data-manual-character-field="prompt"]'
                            )];
                            prompts.at(-1)?.focus();
                        });
                        return;
                    }

                    if (action.dataset.manualEditAction === 'remove-character') {
                        const characterCard = action.closest('[data-manual-character-index]');
                        const characterIndex = Number(characterCard?.dataset.manualCharacterIndex);
                        if (!Number.isInteger(characterIndex)) return;

                        const characters = Array.isArray(manualDraft.characters)
                            ? [...manualDraft.characters]
                            : [];
                        characters.splice(characterIndex, 1);
                        manualDraft.characters = renumberAnalysisCharacters(characters);
                        renderManualAddEditor();
                        return;
                    }

                    if (action.dataset.manualEditAction === 'cancel-add') {
                        manualDraft = {
                            name: '',
                            note: '',
                            sourceUrl: '',
                            tags: '',
                            negativeTags: '',
                            characters: [],
                            categories: []
                        };
                        $('#nai-manual-editor-root').innerHTML = '';
                        $('#nai-manual-status').textContent = '';
                        setCreatePanelOpen('library', false);
                        return;
                    }
                }

                const saveButton = event.target.closest('[data-action="save-import"]');
                if (saveButton) {
                    saveImportedConcept();
                }
            }
        );

        $('#nai-library-search').addEventListener(
            'input',
            () => {
                expandedLibraryCards.clear();
                expandedLibraryNotes.clear();
                renderLibrary();
            }
        );

        $('#nai-library-category-bar').addEventListener(
            'click',
            event => {
                const editToggle = event.target.closest('[data-library-category-edit-toggle]');
                if (editToggle) {
                    libraryCategoryEditMode = !libraryCategoryEditMode;
                    renderLibraryCategoryBar();
                    return;
                }

                const addButton = event.target.closest('[data-library-category-add]');
                if (addButton) {
                    const raw = window.prompt('새 분류 이름');
                    if (raw === null) return;

                    const name = normalizeLibraryCategoryName(raw);
                    if (!name) return;
                    if (name === '전체' || name === '+') {
                        $('#nai-library-status').textContent = '이 이름은 분류로 사용할 수 없습니다.';
                        return;
                    }

                    const categories = getLibraryCategories();
                    if (categories.includes(name)) {
                        $('#nai-library-status').textContent = `"${name}" 분류는 이미 있습니다.`;
                        return;
                    }

                    categories.push(name);
                    saveLibraryCategories(categories);
                    renderLibrary();
                    $('#nai-library-status').textContent = `"${name}" 분류를 추가했습니다.`;
                    return;
                }

                const moveButton = event.target.closest('[data-library-category-move]');
                if (moveButton) {
                    moveLibraryCategory(
                        moveButton.dataset.libraryCategoryName,
                        moveButton.dataset.libraryCategoryMove
                    );
                    return;
                }

                const deleteButton = event.target.closest('[data-library-category-delete]');
                if (deleteButton) {
                    deleteLibraryCategory(deleteButton.dataset.libraryCategoryDelete);
                    return;
                }

                const filterButton = event.target.closest('[data-library-category-filter]');
                if (!filterButton) return;

                const name = filterButton.dataset.libraryCategoryFilter;
                if (name === '__all__') {
                    activeLibraryCategories.clear();
                } else if (activeLibraryCategories.has(name)) {
                    activeLibraryCategories.delete(name);
                } else {
                    activeLibraryCategories.add(name);
                }

                expandedLibraryCards.clear();
                expandedLibraryNotes.clear();
                renderLibrary();
            }
        );

        $('#nai-library-category-bar').addEventListener(
            'change',
            event => {
                const input = event.target.closest('[data-library-category-rename]');
                if (!input) return;
                renameLibraryCategory(
                    input.dataset.libraryCategoryRename,
                    input.value
                );
            }
        );

        $('#nai-library-category-bar').addEventListener(
            'keydown',
            event => {
                const input = event.target.closest('[data-library-category-rename]');
                if (!input) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.blur();
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    input.value = input.dataset.libraryCategoryRename || '';
                    input.blur();
                }
            }
        );

        function finishLibraryDrag({ cancel = false } = {}) {
            const state = libraryDragState;
            if (!state) return;

            const { list, card, handle, pointerId, moved } = state;
            try {
                if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
            } catch (_) {}

            handle.classList.remove('dragging');
            card.classList.remove('nai-library-dragging');
            list.classList.remove('nai-library-drag-active');
            libraryDragState = null;

            if (moved) libraryDragSuppressClickUntil = Date.now() + 550;

            if (cancel) {
                renderLibrary();
                return;
            }

            if (!moved) return;
            const orderedIds = [...list.querySelectorAll('[data-concept-id]')]
                .map(node => node.dataset.conceptId)
                .filter(Boolean);
            saveVisibleLibraryOrder(orderedIds);
            renderLibrary();
        }

        function handleLibraryDragMove(event) {
            const state = libraryDragState;
            if (!state || event.pointerId !== state.pointerId) return;

            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if (!state.moved && Math.hypot(dx, dy) < 5) return;

            if (!state.moved) {
                state.moved = true;
                state.list.classList.add('nai-library-drag-active');
                state.card.classList.add('nai-library-dragging');
                state.handle.classList.add('dragging');
            }

            event.preventDefault();

            const candidates = document.elementsFromPoint(event.clientX, event.clientY)
                .map(node => node.closest?.('.nai-concept-card[data-concept-id]:not([data-library-edit-card])'))
                .filter(Boolean);
            const target = candidates.find(node => node !== state.card && node.parentElement === state.list);
            if (!target) return;

            const rect = target.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (before) {
                if (state.card.nextElementSibling !== target) state.list.insertBefore(state.card, target);
            } else if (target.nextElementSibling !== state.card) {
                state.list.insertBefore(state.card, target.nextElementSibling);
            }
        }

        function startLibraryDrag(event) {
            const handle = event.target.closest('[data-library-drag-handle]');
            if (!handle || event.button !== 0) return;
            const card = handle.closest('.nai-concept-card[data-concept-id]:not([data-library-edit-card])');
            const list = handle.closest('#nai-library-list');
            if (!card || !list) return;

            event.preventDefault();
            event.stopPropagation();
            libraryDragState = {
                list,
                card,
                handle,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false
            };

            try {
                handle.setPointerCapture?.(event.pointerId);
            } catch (_) {}
        }

        $('#nai-library-list').addEventListener('pointerdown', startLibraryDrag);
        $('#nai-library-list').addEventListener('pointermove', handleLibraryDragMove);
        $('#nai-library-list').addEventListener('pointerup', event => {
            if (libraryDragState && event.pointerId === libraryDragState.pointerId) {
                finishLibraryDrag();
            }
        });
        $('#nai-library-list').addEventListener('pointercancel', event => {
            if (libraryDragState && event.pointerId === libraryDragState.pointerId) {
                finishLibraryDrag({ cancel: true });
            }
        });

        $('#nai-library-list').addEventListener(
            'click',
            event => {
                if (Date.now() < libraryDragSuppressClickUntil) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                if (event.target.closest('[data-library-drag-handle]')) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                const editNoteToggle = event.target.closest('[data-library-edit-note-toggle]');
                if (editNoteToggle) {
                    syncLibraryEditDraftFromDom();
                    if (!editingDraft) return;

                    const card = editNoteToggle.closest('[data-library-edit-card]');
                    const body = card?.querySelector('[data-library-edit-note-body]');
                    const nextOpen = editNoteToggle.getAttribute('aria-expanded') !== 'true';
                    editingDraft._noteOpen = nextOpen;
                    editNoteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    editNoteToggle.textContent = `메모 ${nextOpen ? '▼' : '◀'}`;
                    if (body) body.hidden = !nextOpen;

                    if (nextOpen) {
                        requestAnimationFrame(() => {
                            const textarea = body?.querySelector('[data-edit-field="note"]');
                            if (textarea) fitAnalysisTextarea(textarea);
                        });
                    }
                    return;
                }

                const tabButton = event.target.closest('[data-analysis-prompt-tab]');
                if (tabButton && tabButton.closest('[data-library-edit-card]')) {
                    activateAnalysisPromptTab(
                        tabButton.closest('.nai-analysis-prompt-editor'),
                        tabButton.dataset.analysisPromptTab
                    );
                    return;
                }

                const editAction = event.target.closest('[data-library-edit-action]');
                if (editAction) {
                    syncLibraryEditDraftFromDom();
                    if (!editingDraft) return;

                    if (editAction.dataset.libraryEditAction === 'add-character') {
                        const characters = Array.isArray(editingDraft.characters)
                            ? [...editingDraft.characters]
                            : [];
                        characters.push({
                            name: `Character ${characters.length + 1}`,
                            prompt: '',
                            negativePrompt: '',
                            _analysisDraft: true
                        });
                        editingDraft.characters = characters;
                        renderLibrary();

                        requestAnimationFrame(() => {
                            const prompts = [...$('#nai-library-list').querySelectorAll(
                                '[data-library-edit-card] [data-edit-character-field="prompt"]'
                            )];
                            prompts.at(-1)?.focus();
                        });
                        return;
                    }

                    if (editAction.dataset.libraryEditAction === 'remove-character') {
                        const characterCard = editAction.closest('[data-edit-character-index]');
                        const characterIndex = Number(characterCard?.dataset.editCharacterIndex);
                        if (!Number.isInteger(characterIndex)) return;

                        const characters = Array.isArray(editingDraft.characters)
                            ? [...editingDraft.characters]
                            : [];
                        characters.splice(characterIndex, 1);
                        editingDraft.characters = renumberAnalysisCharacters(characters);
                        renderLibrary();
                        return;
                    }
                }

                const categoryAssign = event.target.closest('[data-library-category-assign]');
                if (categoryAssign) {
                    const card = categoryAssign.closest('[data-concept-id]');
                    const id = card?.dataset.conceptId;
                    const name = normalizeLibraryCategoryName(categoryAssign.dataset.libraryCategoryAssign);
                    if (!id || !name) return;

                    const isEditCard = !!card?.matches('[data-library-edit-card]');
                    if (isEditCard) syncLibraryEditDraftFromDom();

                    const library = getLibrary();
                    const index = library.findIndex(row => row.id === id);
                    if (index < 0) return;

                    const item = normalizeConceptRecord(library[index]);
                    const sourceCategories =
                        isEditCard && editingDraft?.id === id
                            ? editingDraft.categories
                            : item.categories;
                    const selected = new Set(normalizeLibraryCategoryList(sourceCategories));
                    if (selected.has(name)) selected.delete(name);
                    else selected.add(name);

                    const nextCategories = normalizeLibraryCategoryList([...selected]);
                    if (isEditCard && editingDraft?.id === id) {
                        editingDraft.categories = nextCategories;
                    }

                    library[index] = {
                        ...item,
                        categories: nextCategories,
                        updatedAt: Date.now()
                    };
                    saveLibrary(library);
                    renderLibrary();
                    return;
                }

                const cardToggle = event.target.closest('[data-library-card-toggle]');
                if (cardToggle && !event.target.closest('[data-concept-action]')) {
                    const card = cardToggle.closest('[data-concept-id]');
                    const id = card?.dataset.conceptId;
                    if (!id) return;

                    const nextOpen = !expandedLibraryCards.has(id);
                    if (nextOpen) expandedLibraryCards.add(id);
                    else expandedLibraryCards.delete(id);

                    renderLibrary();
                    return;
                }

                const noteToggle = event.target.closest('[data-library-note-toggle]');
                if (noteToggle) {
                    const card = noteToggle.closest('[data-concept-id]');
                    const id = card?.dataset.conceptId;
                    if (!id) return;

                    const body = card.querySelector('[data-library-note-body]');
                    const textarea = body?.querySelector('[data-library-note]');
                    const nextOpen = noteToggle.getAttribute('aria-expanded') !== 'true';

                    noteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    noteToggle.classList.toggle('nai-library-note-active', nextOpen);
                    if (body) body.hidden = !nextOpen;
                    if (nextOpen) expandedLibraryNotes.add(id);
                    else expandedLibraryNotes.delete(id);

                    if (nextOpen && textarea) {
                        requestAnimationFrame(() => fitAnalysisTextarea(textarea));
                    }
                    return;
                }

                const button = event.target.closest('[data-concept-action]');
                if (button) {
                    handleConceptAction(button);
                }
            }
        );

        $('#nai-library-list').addEventListener(
            'input',
            event => {
                const noteField = event.target.closest('[data-library-note]');
                if (!noteField) return;

                const card = noteField.closest('[data-concept-id]');
                const id = card?.dataset.conceptId;
                if (!id) return;

                const value = noteField.value;
                const preview = card.querySelector('[data-library-note-preview]');
                if (preview) {
                    preview.textContent = value.trim();
                    preview.hidden = !value.trim();
                }

                const separator = card.querySelector('[data-library-note-separator]');
                if (separator) separator.hidden = !value.trim();

                scheduleLibraryNoteSave(id, value);
            }
        );

        $('#nai-library-list').addEventListener(
            'focusout',
            event => {
                const noteField = event.target.closest('[data-library-note]');
                if (!noteField) return;

                const card = noteField.closest('[data-concept-id]');
                const id = card?.dataset.conceptId;
                if (!id) return;
                persistLibraryNote(id, noteField.value);
            }
        );



        $('#nai-ai-results').addEventListener(
            'change',
            event => {
                const card = event.target.closest('[data-result-id]');
                if (!card) return;
                syncAnalysisResultsFromDom();
                refreshAnalysisDuplicateBadges();
            }
        );

        $('#nai-ai-results').addEventListener(
            'input',
            event => {
                const field = event.target.closest(
                    '[data-result-field="tags"], [data-result-field="negativeTags"], [data-result-character-field="prompt"], [data-result-character-field="negativePrompt"]'
                );
                if (!field) return;
                syncAnalysisResultsFromDom();
                refreshAnalysisDuplicateBadges();
            }
        );

        $('#nai-ai-results').addEventListener(
            'click',
            event => {
                const noteToggle = event.target.closest('[data-result-note-toggle]');
                if (noteToggle) {
                    const card = noteToggle.closest('[data-result-id]');
                    const item = analysisResults.find(
                        row => row.id === card?.dataset.resultId
                    );
                    const body = card?.querySelector('[data-result-note-body]');
                    const nextOpen = noteToggle.getAttribute('aria-expanded') !== 'true';
                    if (item) item._noteOpen = nextOpen;
                    noteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    noteToggle.textContent = `메모 ${nextOpen ? '▼' : '◀'}`;
                    if (body) body.hidden = !nextOpen;
                    if (nextOpen) {
                        requestAnimationFrame(() => {
                            const textarea = body?.querySelector('[data-result-field="note"]');
                            if (textarea) fitAnalysisTextarea(textarea);
                        });
                    }
                    return;
                }

                const categoryButton = event.target.closest(
                    '[data-result-category-assign]'
                );
                if (categoryButton) {
                    const card = categoryButton.closest('[data-result-id]');
                    if (!card) return;

                    syncAnalysisResultsFromDom();
                    const item = analysisResults.find(
                        row => row.id === card.dataset.resultId
                    );
                    if (!item) return;

                    const name = normalizeLibraryCategoryName(
                        categoryButton.dataset.resultCategoryAssign
                    );
                    if (!name) return;

                    const selected = new Set(
                        normalizeLibraryCategoryList(item.categories)
                    );
                    if (selected.has(name)) selected.delete(name);
                    else selected.add(name);
                    item.categories = normalizeLibraryCategoryList([...selected]);

                    renderAnalysisResults();
                    return;
                }

                const tabButton = event.target.closest(
                    '[data-analysis-prompt-tab]'
                );
                if (tabButton) {
                    const editor = tabButton.closest('[data-result-prompt-editor]');
                    activateAnalysisPromptTab(
                        editor,
                        tabButton.dataset.analysisPromptTab
                    );
                    return;
                }

                const actionButton = event.target.closest(
                    '[data-result-action]'
                );
                if (!actionButton) return;

                const card = actionButton.closest('[data-result-id]');
                if (!card) return;

                syncAnalysisResultsFromDom();

                const item = analysisResults.find(
                    row => row.id === card.dataset.resultId
                );
                if (!item) return;

                if (actionButton.dataset.resultAction === 'add-character') {
                    const characters = normalizeCharacterRows(item.characters);
                    characters.push({
                        name: nextAnalysisCharacterName(characters),
                        prompt: '',
                        negativePrompt: '',
                        _analysisDraft: true
                    });
                    item.characters = characters;

                    renderAnalysisResults();

                    requestAnimationFrame(() => {
                        const refreshed = $$('#nai-ai-results [data-result-id]').find(
                            row => row.dataset.resultId === item.id
                        );
                        const prompts = refreshed
                            ? [...refreshed.querySelectorAll(
                                '[data-result-character-field="prompt"]'
                            )]
                            : [];
                        prompts.at(-1)?.focus();
                    });
                    return;
                }

                if (actionButton.dataset.resultAction === 'remove-character') {
                    const characterCard = actionButton.closest(
                        '[data-result-character-index]'
                    );
                    const characterIndex = Number(
                        characterCard?.dataset.resultCharacterIndex
                    );
                    if (!Number.isInteger(characterIndex)) return;

                    const characters = normalizeCharacterRows(item.characters);
                    characters.splice(characterIndex, 1);
                    item.characters = renumberAnalysisCharacters(characters);
                    renderAnalysisResults();
                }
            }
        );

        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) {
                overlay.remove();
            }
        });

        document.addEventListener(
            'keydown',
            function onKeydown(event) {
                if (!document.getElementById(MODAL_ID)) {
                    document.removeEventListener(
                        'keydown',
                        onKeydown
                    );
                    return;
                }

                if (event.key === 'Escape') {
                    overlay.remove();
                    document.removeEventListener(
                        'keydown',
                        onKeydown
                    );
                }
            }
        );

        const onGlobalAnalysisState = () => {
            if (!overlay.isConnected) {
                document.removeEventListener(
                    ANALYSIS_STATE_EVENT,
                    onGlobalAnalysisState
                );
                return;
            }

            renderAnalysisResults();
            syncGlobalAnalyzeUi();
        };
        document.addEventListener(
            ANALYSIS_STATE_EVENT,
            onGlobalAnalysisState
        );

        loadSettingsIntoForm();

        if (analysisUrl) {
            const importUrl = $('#nai-import-url');
            if (importUrl) importUrl.value = analysisUrl;
        }
        if (analysisStatusText) {
            const importStatus = $('#nai-import-status');
            if (importStatus) importStatus.textContent = analysisStatusText;
        }

        renderLibrary();
        renderAnalysisResults();
        syncGlobalAnalyzeUi();
        switchTab(activeTab);
    }

    let injectionFrame = null;

    const observer = new MutationObserver(() => {
        if (injectionFrame) {
            cancelAnimationFrame(injectionFrame);
        }

        injectionFrame = requestAnimationFrame(() => {
            injectionFrame = null;
            injectNavbarButton();
        });
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    injectNavbarButton();
})();
