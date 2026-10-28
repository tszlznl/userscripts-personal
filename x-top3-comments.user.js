// ==UserScript==
// @name         X · 推文前三条回复
// @namespace    local.x-top3-comments
// @version      0.2.2
// @description  在 X 首页时间线每条推文、以及单条推文页，展示前三条回复
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const PANEL_ATTR = "data-xt3-panel";
  const STYLE_ID = "xt3-style";
  const META_KEY = "xt3-home-meta-v1";
  const MAX_REPLIES = 3;
  const MIN_GAP_MS = 1500;
  const COOLDOWN_MS = 30000;
  const MAX_CACHE = 300;
  const HOME_PATH_RE = /^\/home\/?$/;
  const STATUS_PATH_RE = /^\/([^/]+)\/status\/(\d+)/;

  // Public web client token; only used when bundle extraction fails.
  const FALLBACK_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  const FEATURES = {
    rweb_video_screen_enabled: false,
    rweb_cashtags_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    rweb_sports_post_context_enabled: false,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    rweb_conversational_replies_downvote_enabled: false,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: true,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_nested_quote_preview_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_made_on_x_label_enabled: false,
    responsive_web_grok_community_note_auto_translation_is_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };

  const FIELD_TOGGLES = {
    withPayments: false,
    withDmBlocks: false,
    withArticleRichContentState: true,
    withArticlePlainText: false,
    withArticleSummaryText: true,
    withArticleVoiceOver: true,
    withGrokAnalyze: false,
    withDisallowedReplyControls: false,
  };

  const cache = new Map();
  const pending = new Set();
  const queue = [];
  let draining = false;
  let lastRequestAt = 0;
  let metaPromise = null;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${PANEL_ATTR}] { margin: 0 16px 12px; font-family: inherit; font-size: 15px; line-height: 1.45; }
      [${PANEL_ATTR}] .xt3-toggle { display: block; width: 100%; padding: 8px 4px; border: 0; background: transparent; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
      [${PANEL_ATTR}] .xt3-toggle:hover { text-decoration: underline; }
      [${PANEL_ATTR}] .xt3-box { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border-radius: 16px; overflow-wrap: anywhere; }
      [${PANEL_ATTR}] .xt3-box[hidden] { display: none; }
      [${PANEL_ATTR}] .xt3-row { margin: 0; }
      [${PANEL_ATTR}] .xt3-name { font-weight: 600; }
      [${PANEL_ATTR}] .xt3-text { white-space: pre-wrap; }
      [${PANEL_ATTR}] .xt3-empty { margin: 0; }
      [${PANEL_ATTR}] .xt3-retry { margin-left: 6px; border: 0; background: transparent; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; padding: 0; }
      [${PANEL_ATTR}][data-theme="dark"] .xt3-toggle { color: #8b98a5; }
      [${PANEL_ATTR}][data-theme="dark"] .xt3-box { background: rgba(255, 255, 255, 0.10); border: 1px solid rgba(255, 255, 255, 0.12); color: #e7e9ea; }
      [${PANEL_ATTR}][data-theme="dark"] .xt3-name { color: #ffffff; }
      [${PANEL_ATTR}][data-theme="dark"] .xt3-empty { color: #71767b; }
      [${PANEL_ATTR}][data-theme="light"] .xt3-toggle { color: #536471; }
      [${PANEL_ATTR}][data-theme="light"] .xt3-box { background: #f7f9f9; border: 1px solid #eff3f4; color: #0f1419; }
      [${PANEL_ATTR}][data-theme="light"] .xt3-name { color: #0f1419; }
      [${PANEL_ATTR}][data-theme="light"] .xt3-empty { color: #536471; }
    `;
    document.head.append(style);
  }

  function getMode() {
    if (HOME_PATH_RE.test(location.pathname)) return { type: "home" };
    const match = location.pathname.match(STATUS_PATH_RE);
    if (match) return { type: "status", tweetId: match[2] };
    return { type: "none" };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? match[1] : "";
  }

  function decodeEntities(value) {
    return value
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'");
  }

  function stripLeadingMentions(value) {
    return value.replace(/^(?:@[A-Za-z0-9_]{1,15}\s+)+/, "");
  }

  function detectTheme() {
    const background = getComputedStyle(document.body).backgroundColor;
    const rgb = background.match(/\d+(?:\.\d+)?/g);
    if (!rgb || background === "rgba(0, 0, 0, 0)") {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    const [r, g, b] = rgb.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
  }

  function getTweetId(article) {
    const timeHref = article.querySelector("time")?.closest("a")?.getAttribute("href");
    if (timeHref) return timeHref.match(/\/status\/(\d+)/)?.[1] ?? null;
    const fallback = [...article.querySelectorAll('a[href*="/status/"]')]
      .map((anchor) => anchor.getAttribute("href"))
      .find((href) => /^\/[^/]+\/status\/\d+$/.test(href));
    return fallback?.match(/\/status\/(\d+)/)?.[1] ?? null;
  }

  function findFocalArticle(scope, tweetId) {
    const target = new RegExp(`^/[^/]+/status/${tweetId}/?$`);
    return (
      [...scope.querySelectorAll('article[data-testid="tweet"]')].find((article) =>
        [...article.querySelectorAll('a[href*="/status/"]')].some((anchor) => {
          try {
            return target.test(new URL(anchor.getAttribute("href"), location.origin).pathname);
          } catch {
            return false;
          }
        }),
      ) ?? null
    );
  }

  function getBundleUrls() {
    const urls = [
      ...new Set([
        ...[...document.querySelectorAll("script[src]")].map((script) => script.src),
        ...performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /\/client-web\/.+\.js(\?|$)/.test(name)),
      ]),
    ].filter((url) => url.includes("client-web"));
    const main = urls.filter((url) => /\/main\.[^/?]+\.js/.test(url));
    const rest = urls.filter((url) => !main.includes(url));
    return [...main, ...rest].slice(0, 6);
  }

  function extractQueryId(text) {
    return (
      text.match(/queryId:"([^"]+)",operationName:"TweetDetail"/)?.[1] ??
      text.match(/operationName:"TweetDetail"[^}]{0,600}?queryId:"([^"]+)"/)?.[1] ??
      null
    );
  }

  function extractBearer(text) {
    return text.match(/Bearer ([A-Za-z0-9%_\-=.]{60,})/)?.[1] ?? null;
  }

  function readStoredMeta() {
    try {
      const raw = sessionStorage.getItem(META_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function resetMeta() {
    metaPromise = null;
    try {
      sessionStorage.removeItem(META_KEY);
    } catch {
      // Storage can be unavailable; the in-memory reset is enough.
    }
  }

  function getMeta() {
    if (metaPromise) return metaPromise;
    metaPromise = (async () => {
      const bundleUrls = getBundleUrls();
      if (!bundleUrls.length) throw new Error("bundle not found");
      const primaryUrl = bundleUrls[0];
      const stored = readStoredMeta();
      if (stored?.bundleUrl === primaryUrl && stored.queryId && stored.bearer) {
        return stored;
      }
      let queryId = null;
      let bearer = null;
      for (const url of bundleUrls) {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) continue;
        const text = await response.text();
        queryId = queryId ?? extractQueryId(text);
        bearer = bearer ?? extractBearer(text);
        if (queryId && bearer) break;
      }
      bearer = bearer ?? FALLBACK_BEARER;
      if (!queryId || !bearer) throw new Error("query meta not found");
      const meta = { bundleUrl: primaryUrl, queryId, bearer };
      try {
        sessionStorage.setItem(META_KEY, JSON.stringify(meta));
      } catch {
        // Storage can be unavailable; the in-memory promise still caches it.
      }
      return meta;
    })().catch((error) => {
      metaPromise = null;
      throw error;
    });
    return metaPromise;
  }

  function unwrapTweet(result) {
    return result?.__typename === "TweetWithVisibilityResults" ? result.tweet : result;
  }

  function parseReplies(json, focalId) {
    const instructions = json?.data?.threaded_conversation_with_injections_v2?.instructions ?? [];
    const tweets = [];
    for (const instruction of instructions) {
      for (const entry of instruction.entries ?? []) {
        const direct = unwrapTweet(entry.content?.itemContent?.tweet_results?.result);
        if (direct) tweets.push(direct);
        for (const item of entry.content?.items ?? []) {
          const tweet = unwrapTweet(item.item?.itemContent?.tweet_results?.result);
          if (tweet) tweets.push(tweet);
        }
      }
    }
    return tweets
      .filter(
        (tweet) =>
          tweet?.rest_id &&
          tweet.rest_id !== focalId &&
          tweet.legacy?.in_reply_to_status_id_str === focalId,
      )
      .slice(0, MAX_REPLIES)
      .map((tweet) => {
        const userResult = tweet.core?.user_results?.result;
        const user = { ...userResult?.legacy, ...userResult?.core };
        const raw = tweet.note_tweet?.note_tweet_results?.result?.text ?? tweet.legacy?.full_text ?? "";
        const text = stripLeadingMentions(decodeEntities(raw));
        const hasMedia = Boolean(tweet.legacy?.extended_entities?.media?.length);
        return {
          name: user.name || user.screen_name || "匿名",
          text: text || (hasMedia ? "（媒体内容）" : ""),
        };
      });
  }

  async function fetchReplies(tweetId) {
    const meta = await getMeta();
    const ct0 = getCookie("ct0");
    if (!ct0) throw new Error("ct0 missing");
    const variables = {
      focalTweetId: tweetId,
      with_rux_injections: false,
      rankingMode: "Relevance",
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
    };
    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(FEATURES),
      fieldToggles: JSON.stringify(FIELD_TOGGLES),
    });
    const response = await fetch(`/i/api/graphql/${meta.queryId}/TweetDetail?${params}`, {
      headers: {
        authorization: `Bearer ${meta.bearer}`,
        "x-csrf-token": ct0,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
      },
      credentials: "include",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) resetMeta();
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return parseReplies(await response.json(), tweetId);
  }

  function panelSelector(tweetId) {
    return `[${PANEL_ATTR}][data-tweet-id="${tweetId}"]`;
  }

  function fillBox(box, tweetId) {
    box.textContent = "";
    const state = cache.get(tweetId);
    if (!state) {
      const loading = document.createElement("p");
      loading.className = "xt3-empty";
      loading.textContent = "加载回复…";
      box.append(loading);
      return;
    }
    if (state.error) {
      const error = document.createElement("p");
      error.className = "xt3-empty";
      error.textContent = "无法加载回复";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "xt3-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cache.delete(tweetId);
        fillBox(box, tweetId);
        ensureFetch(tweetId);
      });
      error.append(retry);
      box.append(error);
      return;
    }
    if (state.replies.length === 0) {
      const empty = document.createElement("p");
      empty.className = "xt3-empty";
      empty.textContent = "暂无回复";
      box.append(empty);
      return;
    }
    for (const reply of state.replies) {
      const row = document.createElement("p");
      row.className = "xt3-row";
      const name = document.createElement("span");
      name.className = "xt3-name";
      name.textContent = `@${reply.name}`;
      const colon = document.createElement("span");
      colon.textContent = "：";
      const text = document.createElement("span");
      text.className = "xt3-text";
      text.textContent = reply.text;
      row.append(name, colon, text);
      box.append(row);
    }
  }

  function createPanel(tweetId) {
    const element = document.createElement("div");
    element.setAttribute(PANEL_ATTR, "");
    element.setAttribute("data-tweet-id", tweetId);
    element.setAttribute("data-theme", detectTheme());

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "xt3-toggle";
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = "收起回复 ^";

    const box = document.createElement("div");
    box.className = "xt3-box";
    fillBox(box, tweetId);

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expand = box.hidden;
      box.hidden = !expand;
      toggle.setAttribute("aria-expanded", String(expand));
      toggle.textContent = expand ? "收起回复 ^" : "展开回复 v";
    });

    element.append(toggle, box);
    return element;
  }

  function renderPanel(panel, tweetId) {
    const box = panel.querySelector(".xt3-box");
    if (box) fillBox(box, tweetId);
  }

  function updatePanels(tweetId) {
    document.querySelectorAll(panelSelector(tweetId)).forEach((panel) => renderPanel(panel, tweetId));
  }

  function isCellNearViewport(cell) {
    const rect = cell.getBoundingClientRect();
    return rect.bottom > -300 && rect.top < innerHeight + 300;
  }

  function hasFetchTarget(tweetId) {
    const panel = document.querySelector(panelSelector(tweetId));
    const cell = panel?.closest('div[data-testid="cellInnerDiv"]');
    return cell ? isCellNearViewport(cell) : false;
  }

  function trimCache() {
    while (cache.size > MAX_CACHE) {
      cache.delete(cache.keys().next().value);
    }
  }

  function ensureFetch(tweetId) {
    if (cache.has(tweetId) || pending.has(tweetId) || queue.includes(tweetId)) return;
    queue.push(tweetId);
    drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        if (getMode().type === "none") break;
        const tweetId = queue.shift();
        if (cache.has(tweetId) || pending.has(tweetId)) continue;
        if (!hasFetchTarget(tweetId)) continue;
        pending.add(tweetId);
        const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastRequestAt));
        if (wait) await sleep(wait);
        if (getMode().type === "none") {
          pending.delete(tweetId);
          queue.unshift(tweetId);
          break;
        }
        lastRequestAt = Date.now();
        try {
          const replies = await fetchReplies(tweetId);
          cache.set(tweetId, { replies });
          trimCache();
        } catch (error) {
          cache.set(tweetId, { replies: [], error: true });
          trimCache();
          if (error?.status === 429) lastRequestAt = Date.now() + COOLDOWN_MS;
        } finally {
          pending.delete(tweetId);
        }
        updatePanels(tweetId);
      }
    } finally {
      draining = false;
    }
  }

  function attachPanel(article, knownId) {
    if (article.closest('[data-testid="placementTracking"]')) return;
    const cell = article.closest('div[data-testid="cellInnerDiv"]');
    if (!cell) return;
    const tweetId = knownId || article.dataset.xt3Id || getTweetId(article);
    if (!tweetId) return;
    article.dataset.xt3Id = tweetId;
    let panel = cell.querySelector(`:scope > [${PANEL_ATTR}]`);
    if (panel && panel.getAttribute("data-tweet-id") !== tweetId) {
      panel.remove();
      panel = null;
    }
    if (!panel) {
      panel = createPanel(tweetId);
      cell.append(panel);
      renderPanel(panel, tweetId);
    }
    if (!cache.has(tweetId) && isCellNearViewport(cell)) ensureFetch(tweetId);
  }

  function scan() {
    if (document.hidden) return;
    const mode = getMode();
    if (mode.type === "none") return;
    const scope = document.querySelector('div[data-testid="primaryColumn"]');
    if (!scope) return;
    if (mode.type === "home") {
      for (const article of scope.querySelectorAll('article[data-testid="tweet"]')) {
        attachPanel(article);
      }
      return;
    }
    const focal = findFocalArticle(scope, mode.tweetId);
    if (focal) attachPanel(focal, mode.tweetId);
  }

  setInterval(scan, 800);
  scan();
})();
