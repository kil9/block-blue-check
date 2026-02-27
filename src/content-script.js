(() => {
  const BUTTON_ID = "bbc-block-blue-mentions-btn";
  const STATUS_ID = "bbc-block-blue-mentions-status";
  const RUNNING_ATTR = "data-bbc-running";
  const RESERVED_PATHS = new Set([
    "i",
    "home",
    "explore",
    "search",
    "notifications",
    "messages",
    "compose",
    "settings",
    "login",
    "signup",
    "hashtag",
    "tos",
    "privacy"
  ]);
  let lastSeenUrl = window.location.href;

  function isStatusPage(url = window.location.href) {
    return /https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(url);
  }

  function getPrimaryTweetArticle() {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryColumn) return null;

    return primaryColumn.querySelector('article[data-testid="tweet"]');
  }

  function parseUsernameFromHref(href) {
    if (!href || !href.startsWith("/")) return null;
    const matched = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?|#)/);
    if (!matched) return null;
    const username = matched[1].toLowerCase();
    return RESERVED_PATHS.has(username) ? null : username;
  }

  function parseMentionsFromTweet(articleEl) {
    if (!articleEl) return [];
    const mentionSet = new Set();
    const tweetTextBlocks = articleEl.querySelectorAll('[data-testid="tweetText"]');
    if (tweetTextBlocks.length === 0) return [];

    tweetTextBlocks.forEach((tweetText) => {
      const anchors = tweetText.querySelectorAll("a[href]");
      anchors.forEach((anchor) => {
        const href = anchor.getAttribute("href") || "";
        const username = parseUsernameFromHref(href);
        if (username) {
          mentionSet.add(username);
        }
      });
    });

    return [...mentionSet];
  }

  function parseAuthorFromTweet(articleEl) {
    if (!articleEl) return null;
    const userNameBlock = articleEl.querySelector('[data-testid="User-Name"]');
    if (!userNameBlock) return null;

    const profileLinks = userNameBlock.querySelectorAll('a[href^="/"]');
    for (const link of profileLinks) {
      const username = parseUsernameFromHref(link.getAttribute("href") || "");
      if (username) return username;
    }

    return null;
  }

  function hasVerifiedBadge(articleEl) {
    if (!articleEl) return false;
    const userNameBlock = articleEl.querySelector('[data-testid="User-Name"]');
    if (!userNameBlock) return false;

    if (userNameBlock.querySelector('[data-testid="icon-verified"]')) return true;
    if (userNameBlock.querySelector('svg[aria-label*="Verified"]')) return true;
    if (userNameBlock.querySelector('svg[aria-label*="인증"]')) return true;
    return false;
  }

  function getVisibleTweetArticles() {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryColumn) {
      return [];
    }

    const articleNodes = [...primaryColumn.querySelectorAll('article[data-testid="tweet"]')];
    return articleNodes;
  }

  function collectTargetUsernames() {
    const articleNodes = getVisibleTweetArticles();
    if (articleNodes.length === 0) {
      return {
        directMentions: [],
        relatedTargets: [],
        mergedTargets: [],
        actionableAuthors: [],
        mainAuthor: null,
        authorArticleMap: new Map(),
        verifiedVisibleAuthors: new Set()
      };
    }

    const mainArticle = articleNodes[0];
    const mainAuthor = parseAuthorFromTweet(mainArticle);
    const directMentions = parseMentionsFromTweet(mainArticle);
    const relatedSet = new Set();
    const authorArticleMap = new Map();
    const verifiedVisibleAuthors = new Set();

    articleNodes.forEach((articleEl, index) => {
      const author = parseAuthorFromTweet(articleEl);
      if (author) {
        if (!authorArticleMap.has(author)) {
          authorArticleMap.set(author, articleEl);
        }
        if (hasVerifiedBadge(articleEl)) {
          verifiedVisibleAuthors.add(author);
        }
        if (index > 0) relatedSet.add(author);
      }
      if (index > 0) {
        const mentions = parseMentionsFromTweet(articleEl);
        mentions.forEach((username) => relatedSet.add(username));
      }
    });

    const mergedTargets = [...new Set([...directMentions, ...relatedSet])].filter(
      (username) => username !== mainAuthor
    );
    const actionableAuthors = mergedTargets.filter((username) => authorArticleMap.has(username));

    return {
      directMentions,
      relatedTargets: [...relatedSet],
      mergedTargets,
      actionableAuthors,
      mainAuthor,
      authorArticleMap,
      verifiedVisibleAuthors
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getNodeText(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findBlockMenuItem(menuEl) {
    if (!menuEl) return { node: null, reason: "menu-not-found" };
    const menuItems = menuEl.querySelectorAll('[role="menuitem"]');

    for (const item of menuItems) {
      const text = getNodeText(item);
      if (!text) continue;

      if (/unblock|차단\s*해제/i.test(text)) {
        return { node: null, reason: "already-blocked" };
      }

      if (/^block\b|차단/.test(text) || /block\s*@/i.test(text)) {
        return { node: item, reason: null };
      }
    }

    return { node: null, reason: "block-item-not-found" };
  }

  async function waitForElement(getter, timeoutMs = 3500, intervalMs = 120) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = getter();
      if (found) return found;
      await sleep(intervalMs);
    }
    return null;
  }

  function closeOpenMenus() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function findCaretButton(articleEl) {
    return (
      articleEl.querySelector('button[data-testid="caret"]') ||
      articleEl.querySelector('button[aria-label="More"]') ||
      articleEl.querySelector('button[aria-label="More options"]') ||
      articleEl.querySelector('button[aria-label="더 보기"]') ||
      articleEl.querySelector('button[aria-label="더보기"]') ||
      articleEl.querySelector('button[aria-label="추가 옵션"]')
    );
  }

  async function blockVisibleAuthorByMenu(username, articleEl) {
    if (!articleEl) {
      throw new Error("트윗 카드 미탐지");
    }

    articleEl.scrollIntoView({ block: "center", behavior: "auto" });
    await sleep(140);

    const caretButton = findCaretButton(articleEl);
    if (!caretButton) {
      throw new Error("더보기 버튼 미탐지");
    }

    caretButton.click();

    const menuEl = await waitForElement(
      () => document.querySelector('div[role="menu"]'),
      2500,
      100
    );
    if (!menuEl) {
      throw new Error("메뉴 열기 실패");
    }

    const blockItemResult = findBlockMenuItem(menuEl);
    if (!blockItemResult.node) {
      closeOpenMenus();
      if (blockItemResult.reason === "already-blocked") {
        return "already-blocked";
      }
      throw new Error("차단 메뉴 미탐지");
    }

    blockItemResult.node.click();

    const confirmButton = await waitForElement(() => {
      const byTestId = document.querySelector('button[data-testid="confirmationSheetConfirm"]');
      if (byTestId && !byTestId.disabled) return byTestId;

      const buttons = document.querySelectorAll('[role="dialog"] button');
      for (const button of buttons) {
        const text = getNodeText(button);
        if (/^block\b|차단/i.test(text) && !/unblock|차단\s*해제/i.test(text) && !button.disabled) {
          return button;
        }
      }
      return null;
    });

    if (!confirmButton) {
      throw new Error("차단 확인 버튼 미탐지");
    }

    confirmButton.click();
    await sleep(500);

    return "blocked";
  }

  function setStatus(message, type = "info") {
    let statusEl = document.getElementById(STATUS_ID);
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.id = STATUS_ID;
      statusEl.className = "bbc-status";
      const button = document.getElementById(BUTTON_ID);
      if (button?.parentElement) {
        button.parentElement.appendChild(statusEl);
      }
    }

    statusEl.dataset.type = type;
    statusEl.textContent = message;
  }

  async function handleBlockClick() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    if (button.getAttribute(RUNNING_ATTR) === "true") return;

    const targets = collectTargetUsernames();
    const screenNames = targets.actionableAuthors;

    if (screenNames.length === 0) {
      setStatus("현재 화면에서 처리 가능한 대상이 없습니다.", "warn");
      return;
    }

    button.setAttribute(RUNNING_ATTR, "true");
    button.disabled = true;
    button.textContent = "차단 진행 중...";

    let visibleBlueTargets = 0;
    let blockedCount = 0;
    let failedCount = 0;
    let skippedNonBlue = 0;
    let skippedAlreadyBlocked = 0;
    const failureReasons = [];

    for (let i = 0; i < screenNames.length; i += 1) {
      const screenName = screenNames[i];
      setStatus(`처리 중: @${screenName} (${i + 1}/${screenNames.length})`, "info");

      try {
        if (!targets.verifiedVisibleAuthors.has(screenName)) {
          skippedNonBlue += 1;
          continue;
        }
        visibleBlueTargets += 1;

        const result = await blockVisibleAuthorByMenu(screenName, targets.authorArticleMap.get(screenName));
        if (result === "already-blocked") {
          skippedAlreadyBlocked += 1;
        } else {
          blockedCount += 1;
        }
      } catch (error) {
        failedCount += 1;
        failureReasons.push(`@${screenName}: ${error?.message || "알 수 없는 오류"}`);
        console.error("[block-blue-check]", error);
      }

      await sleep(900);
    }

    button.removeAttribute(RUNNING_ATTR);
    button.disabled = false;
    button.textContent = "블루체크 멘션 차단";

    const result =
      `원문 멘션 ${targets.directMentions.length}개 + 관련 트윗 대상 ${targets.relatedTargets.length}개 ` +
      `중 화면 블루체크 ${visibleBlueTargets}개, 차단 성공 ${blockedCount}개, 이미차단 ${skippedAlreadyBlocked}개, ` +
      `비파딱 스킵 ${skippedNonBlue}개, 실패 ${failedCount}개`;
    if (failedCount > 0) {
      const firstReason = failureReasons[0] ? ` | 예시 오류: ${failureReasons[0]}` : "";
      setStatus(`${result}${firstReason}`, "warn");
    } else {
      setStatus(result, "success");
    }
  }

  function ensureButton() {
    if (!isStatusPage()) return;

    const article = getPrimaryTweetArticle();
    if (!article) return;

    const actionBar = article.querySelector('div[role="group"]');
    if (!actionBar) return;

    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "bbc-button";
    button.textContent = "블루체크 멘션 차단";
    button.addEventListener("click", handleBlockClick);

    const wrapper = document.createElement("div");
    wrapper.className = "bbc-wrapper";
    wrapper.appendChild(button);

    actionBar.parentElement?.appendChild(wrapper);
  }

  function watchForPageChanges() {
    const observer = new MutationObserver(() => {
      const currentUrl = window.location.href;
      if (lastSeenUrl !== currentUrl) {
        lastSeenUrl = currentUrl;
      }
      ensureButton();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    if (!document.body) return;

    lastSeenUrl = window.location.href;
    ensureButton();
    watchForPageChanges();
  }

  init();
})();
