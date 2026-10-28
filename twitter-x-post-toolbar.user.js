// ==UserScript==
// @name         Twitter/X 帖子工具栏
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  在 Twitter/X 帖子的菜单中添加截图、复制、批量下载图片与截取整个帖子串的功能按钮
// @author       You
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        GM_addStyle
// @grant        GM_download
// @connect      pbs.twimg.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/dom-to-image/2.6.0/dom-to-image.min.js
// @license      MIT
// @downloadURL  https://update.greasyfork.org/scripts/532781/Twitter%20Screenshot%20Button.user.js
// @updateURL    https://update.greasyfork.org/scripts/532781/Twitter%20Screenshot%20Button.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // 仅添加必要的按钮样式
    GM_addStyle(`
        .screenshot-button {
            display: flex;
            align-items: center;
            flex-direction: row;
            width: 100%;
            padding: 12px 16px;
            cursor: pointer;
            font-size: 15px;
            transition-property: background-color, box-shadow;
            transition-duration: 0.2s;
            outline-style: none;
            box-sizing: border-box;
            min-height: 0px;
            min-width: 0px;
            border: 0 solid black;
            background-color: rgba(0, 0, 0, 0);
            margin: 0px;
        }
        .screenshot-button:hover {
            background-color: rgba(15, 20, 25, 0.1);
        }
        .screenshot-icon {
            margin-right: 0px; /* 保持边距为 0，对齐由 flex 处理 */
            width: 18.75px;
            height: 18.75px;
            vertical-align: text-bottom; /* 图标与文本对齐 */
        }
        .screenshot-notification {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background-color: #1DA1F2;
            color: white;
            padding: 10px 20px;
            border-radius: 20px;
            z-index: 9999;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            opacity: 1;
            transition: opacity 0.5s ease-out;
        }
        .screenshot-notification.fade-out {
            opacity: 0;
        }
    `);

    function findTweetMainContent(menuButton) {
        const article = menuButton.closest('article[role="article"]');
        if (!article) return null;
        return article;
    }

    // =========================================================================
    // 截图前的图片预处理
    // dom-to-image 会对容器里的每一个 <img> 单独发一次 XHR
    //   (responseType='blob', timeout=30000)，任意一个不是 200 就 fail() 让整个截图 reject；
    // 带图片的帖子往往还有头像 + 十几个 emoji（每个 emoji 都是一张图），于是变成几十个请求，
    // 再叠加原图变大后拼 SVG 的那一步，就会「等很久也出不来」。
    // 这里先把图片就地转成 data: URL —— 库内部第一行就是
    //   `if (util.isDataUrl(element.src)) return Promise.resolve();`
    // 于是整个网络阶段被跳过，同时按显示尺寸重新编码，data URI 体积也大幅减小。
    // =========================================================================
    const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    function withTimeout(promise, ms, message) {
        let timer;
        return Promise.race([
            Promise.resolve(promise).finally(() => clearTimeout(timer)),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            })
        ]);
    }

    // 必须带 crossOrigin 重新加载，否则 drawImage 会污染 canvas，toDataURL 抛 SecurityError
    function loadImageForEmbed(src, timeoutMs) {
        return withTimeout(new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('图片加载失败(可能不支持跨域)'));
            img.src = src;
        }), timeoutMs || 8000, '图片加载超时');
    }

    function isLosslessSource(src) {
        return /\.png(\?|$)|\.svg(\?|$)|format=png|format=svg|image\/svg/i.test(src);
    }

    // 按「实际显示尺寸 × scale」重新编码：原图动辄 4000px 宽，全塞进 SVG data URI 会直接卡死
    async function toEmbeddedDataUrl(img, scale) {
        const src = img.currentSrc || img.src;
        const loaded = await loadImageForEmbed(src);
        const box = img.getBoundingClientRect();
        const limitW = Math.max(1, Math.round((box.width || loaded.naturalWidth) * scale));
        const limitH = Math.max(1, Math.round((box.height || loaded.naturalHeight) * scale));
        const w = Math.min(loaded.naturalWidth, limitW);
        const h = Math.min(loaded.naturalHeight, limitH);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(loaded, 0, 0, w, h);
        // 照片用 jpeg（png 存照片会大好几倍），emoji / 头像等要透明通道的用 png
        return isLosslessSource(src)
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', 0.92);
    }

    // 就地替换 root 内所有 <img> 的 src，返回 restore()，务必在 finally 里调用
    async function inlineImagesForCapture(root, scale) {
        const imgs = Array.from(root.querySelectorAll('img'));
        const backups = [];
        let ok = 0, failed = 0;

        await Promise.all(imgs.map(async (img) => {
            const src = img.currentSrc || img.src;
            if (!src || /^data:/.test(src)) return;
            try {
                const dataUrl = await toEmbeddedDataUrl(img, scale);
                backups.push({
                    img,
                    src: img.getAttribute('src'),
                    srcset: img.getAttribute('srcset')
                });
                img.removeAttribute('srcset');
                img.src = dataUrl;
                if (img.decode) { try { await img.decode(); } catch (_) {} }
                ok++;
            } catch (e) {
                // 失败的保留原 src，交给 imagePlaceholder 兜底，不会拖死整张截图
                failed++;
                console.warn('[Twitter截图] 图片内联失败:', src, e.message);
            }
        }));

        console.log(`[Twitter截图] 图片内联完成: 成功 ${ok}，失败 ${failed}`);
        return function restore() {
            backups.forEach(({ img, src, srcset }) => {
                if (src === null) img.removeAttribute('src');
                else img.setAttribute('src', src);
                if (srcset !== null) img.setAttribute('srcset', srcset);
            });
        };
    }

    async function takeScreenshot(menuButton) {
        const notification = document.createElement('div');
        notification.className = 'screenshot-notification';
        notification.innerHTML = '正在截图...';
        document.body.appendChild(notification);

        let restoreImages = () => {};

        try {
            const tweetContainer = findTweetMainContent(menuButton);
            if (!tweetContainer) {
                throw new Error('未找到帖子内容');
            }

            // 保存原始样式
            const originalStyles = {
                background: tweetContainer.style.background,
                backgroundColor: tweetContainer.style.backgroundColor,
                margin: tweetContainer.style.margin,
                border: tweetContainer.style.border,
                borderRadius: tweetContainer.style.borderRadius
            };

            // 按设备像素输出即可。原来 `devicePixelRatio * 2` 在 Retina(2x) 上是 4 倍，
            // 画布面积变成 16 倍，PNG 编码会慢到看起来像卡死。
            const scale = Math.min(window.devicePixelRatio || 1, 2);

            // --- 开始背景色检测 ---
            let bgColor = 'rgb(255, 255, 255)'; // 默认白色
            try {
                const bodyStyle = window.getComputedStyle(document.body);
                bgColor = bodyStyle.backgroundColor || bgColor;
                // 若 body 无颜色（透明），尝试主容器
                if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') {
                    const mainContent = document.querySelector('main') || document.querySelector('#react-root'); // 常见容器
                    if (mainContent) {
                        bgColor = window.getComputedStyle(mainContent).backgroundColor || 'rgb(255, 255, 255)';
                    }
                }
                // 检测失败的最终回退
                if (bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') {
                    bgColor = 'rgb(255, 255, 255)';
                }
            } catch (bgError) {
                console.warn("无法检测背景色，默认为白色。", bgError);
                bgColor = 'rgb(255, 255, 255)';
            }
            // --- 结束背景色检测 ---

            const config = {
                height: tweetContainer.offsetHeight * scale,
                width: tweetContainer.offsetWidth * scale,
                style: {
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    width: `${tweetContainer.offsetWidth}px`,
                    height: `${tweetContainer.offsetHeight}px`,
                    margin: 0, // 确保无额外边距影响布局
                    border: 'none', // 拼接时移除边框
                    borderRadius: 0 // 拼接时移除圆角
                },
                quality: 1.0,
                bgcolor: bgColor
            };

            // 取不到的图用透明像素顶替，避免某张图让整个截图 reject
            config.imagePlaceholder = TRANSPARENT_PX;

            // 关键一步：先把帖子里的图片全部转成 data: URL
            notification.innerHTML = '正在处理图片...';
            restoreImages = await inlineImagesForCapture(tweetContainer, scale);
            notification.innerHTML = '正在截图...';

            // 加硬超时，任何情况下都不会无限等待
            const blob = await withTimeout(
                domtoimage.toBlob(tweetContainer, config),
                20000,
                '截图超时（图片过大或网络过慢）'
            );

            notification.innerHTML = '正在写入剪贴板...';
            let copied = false;
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                copied = true;
            } catch (clipError) {
                // 剪贴板写入会因权限/焦点丢失/体积过大被拒；原来这里没有 catch，
                // 通知就永远停在「正在截图...」，看起来就像卡死了
                console.warn('[Twitter截图] 写入剪贴板失败，已提供下载兜底:', clipError);
            }

            notification.innerHTML = `
                <div>${copied ? '截图已复制到剪贴板！' : '剪贴板写入失败，请点下载保存'}</div>
                <button class="download-btn" style="
                    background: white;
                    color: #1DA1F2;
                    border: none;
                    padding: 5px 10px;
                    border-radius: 15px;
                    margin-top: 5px;
                    cursor: pointer;
                ">下载</button>
            `;
            notification.style.backgroundColor = copied ? '#17BF63' : '#E0245E';

            const downloadBtn = notification.querySelector('.download-btn');
            downloadBtn.addEventListener('click', () => {
                const link = document.createElement('a');
                link.download = `twitter-post-${Date.now()}.png`;
                link.href = URL.createObjectURL(blob);
                link.click();
                URL.revokeObjectURL(link.href);
                notification.remove();
            });

            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => notification.remove(), 500);
            }, copied ? 1500 : 8000);
        } catch (error) {
            console.error('截图过程中出错:', error);
            notification.textContent = `截图失败: ${error.message}`;
            notification.style.backgroundColor = '#E0245E';
            setTimeout(() => notification.remove(), 3000);
        } finally {
            // 还原页面上的图片，别把 data: URL 留在 DOM 里
            restoreImages();
        }
    }

    function createScreenshotIcon() {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("xmlns", svgNS);
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "18.75");
        svg.setAttribute("height", "18.75");
        svg.setAttribute("fill", "none"); // 线条图标使用 fill=none
        svg.setAttribute("stroke", "currentColor"); // 通过描边继承颜色
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.classList.add("screenshot-icon");

        // Feather Icons: camera
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z");
        const circle = document.createElementNS(svgNS, "circle");
        circle.setAttribute("cx", "12");
        circle.setAttribute("cy", "13");
        circle.setAttribute("r", "4");

        svg.appendChild(path);
        svg.appendChild(circle);
        return svg;
    }

    function createThreadIcon() {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("xmlns", svgNS);
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "18.75");
        svg.setAttribute("height", "18.75");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.classList.add("screenshot-icon");

        // 简易帖子串图标（点连线）
        const path1 = document.createElementNS(svgNS, "path");
        path1.setAttribute("d", "M6 3v12");
        const circle1 = document.createElementNS(svgNS, "circle");
        circle1.setAttribute("cx", "6");
        circle1.setAttribute("cy", "3");
        circle1.setAttribute("r", "1");
        const circle2 = document.createElementNS(svgNS, "circle");
        circle2.setAttribute("cx", "6");
        circle2.setAttribute("cy", "9");
        circle2.setAttribute("r", "1");
        const circle3 = document.createElementNS(svgNS, "circle");
        circle3.setAttribute("cx", "6");
        circle3.setAttribute("cy", "15");
        circle3.setAttribute("r", "1");

        // 平行元素
        const path2 = document.createElementNS(svgNS, "path");
        path2.setAttribute("d", "M18 9v12");
        const circle4 = document.createElementNS(svgNS, "circle");
        circle4.setAttribute("cx", "18");
        circle4.setAttribute("cy", "9");
        circle4.setAttribute("r", "1");
        const circle5 = document.createElementNS(svgNS, "circle");
        circle5.setAttribute("cx", "18");
        circle5.setAttribute("cy", "15");
        circle5.setAttribute("r", "1");
        const circle6 = document.createElementNS(svgNS, "circle");
        circle6.setAttribute("cx", "18");
        circle6.setAttribute("cy", "21");
        circle6.setAttribute("r", "1");

        svg.appendChild(path1);
        svg.appendChild(circle1);
        svg.appendChild(circle2);
        svg.appendChild(circle3);
        svg.appendChild(path2);
        svg.appendChild(circle4);
        svg.appendChild(circle5);
        svg.appendChild(circle6);

        return svg;
    }

    async function captureThread(menuButton) {
        const notification = document.createElement('div');
        notification.className = 'screenshot-notification';
        notification.innerHTML = '正在截取帖子串...正在查找作者与帖子...';
        document.body.appendChild(notification);

        try {
            // 1. 查找起始帖子与作者
            const originalArticle = findTweetMainContent(menuButton);
            if (!originalArticle) {
                throw new Error('未找到起始帖子。');
            }

            // 查找作者的 @ 用户名
            const userElement = originalArticle.querySelector('[data-testid="User-Name"]');
            let authorHandle = null;
            if (userElement) {
                const spans = userElement.querySelectorAll('span');
                for (const span of spans) {
                    if (span.textContent.startsWith('@')) {
                        authorHandle = span.textContent;
                        break;
                    }
                }
            }

            // 若 data-testid 未找到或 span 中无用户名则回退
            if (!authorHandle) {
                const authorLink = originalArticle.querySelector('a[href*="/status/"][dir="ltr"]');
                if (authorLink) {
                    const linkParts = authorLink.href.split('/');
                    if (linkParts.length > 3) {
                        authorHandle = '@' + linkParts[3];
                    }
                }
            }

            if (!authorHandle) {
                throw new Error('无法可靠确定作者的 @ 用户名。');
            }
            notification.innerHTML = `正在截取 ${authorHandle} 的帖子串...正在展开回复...`;
            console.log(`作者 @用户名: ${authorHandle}`);

            // 2. 循环查找并点击「显示更多回复」
            const conversationContainer = originalArticle.closest('div[data-testid="conversation"]');
            let showMoreButton;
            const maxClicks = 15; // 限制点击次数防止死循环
            let clicks = 0;
            const showMoreSelector = 'span.css-1jxf684.r-bcqeeo.r-1ttztb7.r-qvutc0.r-poiln3';

            while (clicks < maxClicks) {
                showMoreButton = conversationContainer
                    ? conversationContainer.querySelector(showMoreSelector)
                    : document.querySelector(showMoreSelector);

                if (showMoreButton && showMoreButton.textContent.includes('Show') && showMoreButton.closest('div[role="button"]')) {
                    console.log(`点击「显示更多」(${clicks + 1}/${maxClicks})`);
                    notification.innerHTML = `正在截取 ${authorHandle} 的帖子串...正在展开回复 (${clicks + 1})...`;
                    showMoreButton.closest('div[role="button"]').click();
                    clicks++;
                    await new Promise(resolve => setTimeout(resolve, 1500));
                } else {
                    console.log("未找到更多「显示更多」按钮或按钮文本不匹配。");
                    break;
                }
            }
            if (clicks === maxClicks) {
                console.warn("已达到「显示更多」点击次数上限。");
            }

            notification.innerHTML = `正在截取 ${authorHandle} 的帖子串...正在查找所有帖子...`;

            // 3. 仅保留原作者的回复
            const allArticles = Array.from(document.querySelectorAll('article[role="article"]'));
            const authorTweets = allArticles.filter(article => {
                const userElement = article.querySelector('[data-testid="User-Name"]');
                let currentHandle = null;
                if (userElement) {
                    const spans = userElement.querySelectorAll('span');
                    for (const span of spans) {
                        if (span.textContent.startsWith('@')) {
                            currentHandle = span.textContent;
                            break;
                        }
                    }
                }
                if (!currentHandle) {
                    const authorLink = article.querySelector('a[href*="/status/"][dir="ltr"]');
                    if (authorLink) {
                        const linkParts = authorLink.href.split('/');
                        if (linkParts.length > 3) {
                            currentHandle = '@' + linkParts[3];
                        }
                    }
                }
                return currentHandle === authorHandle;
            });

            if (authorTweets.length === 0) {
                authorTweets.push(originalArticle);
            }
            authorTweets.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

            console.log(`找到 ${authorHandle} 的 ${authorTweets.length} 条帖子`);
            notification.innerHTML = `正在截取 ${authorTweets.length} 张截图... (0%)`;

            // 4. 逐条截取每篇帖子
            const blobs = [];
            // 同上：按设备像素输出，Retina 上原来 3 倍画布 × 多帖拼接会直接爆内存
            const scale = Math.min(window.devicePixelRatio || 1, 2);

            for (let i = 0; i < authorTweets.length; i++) {
                const tweet = authorTweets[i];
                const percentage = Math.round(((i + 1) / authorTweets.length) * 100);
                notification.innerHTML = `正在截取 ${authorTweets.length} 张截图... (${percentage}%)`;

                let restoreTweetImages = () => {};
                try {
                    // 检查并点击帖子文本内的「显示更多」
                    const internalShowMoreButton = tweet.querySelector('button[data-testid="tweet-text-show-more-link"]');
                    if (internalShowMoreButton) {
                        console.log(`点击帖子 ${i + 1} 内的「显示更多」`);
                        internalShowMoreButton.click();
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    // 背景色检测
                    let threadBgColor = 'rgb(255, 255, 255)';
                    try {
                        const bodyStyle = window.getComputedStyle(document.body);
                        threadBgColor = bodyStyle.backgroundColor || threadBgColor;
                        if (!threadBgColor || threadBgColor === 'rgba(0, 0, 0, 0)' || threadBgColor === 'transparent') {
                            const mainContent = document.querySelector('main') || document.querySelector('#react-root');
                            if (mainContent) {
                                threadBgColor = window.getComputedStyle(mainContent).backgroundColor || 'rgb(255, 255, 255)';
                            }
                        }
                        if (threadBgColor === 'rgba(0, 0, 0, 0)' || threadBgColor === 'transparent') {
                            threadBgColor = 'rgb(255, 255, 255)';
                        }
                    } catch (bgError) {
                        console.warn("无法检测帖子串背景色，默认为白色。", bgError);
                        threadBgColor = 'rgb(255, 255, 255)';
                    }

                    const config = {
                        height: tweet.offsetHeight * scale,
                        width: tweet.offsetWidth * scale,
                        style: {
                            transform: `scale(${scale})`,
                            transformOrigin: 'top left',
                            width: `${tweet.offsetWidth}px`,
                            height: `${tweet.offsetHeight}px`,
                            margin: 0,
                            border: 'none',
                            borderRadius: 0
                        },
                        quality: 0.95,
                        bgcolor: threadBgColor
                    };

                    config.imagePlaceholder = TRANSPARENT_PX;

                    // 同样先把这一条帖子的图片内联，跳过 dom-to-image 的逐图 XHR
                    notification.innerHTML = `正在处理第 ${i + 1} 条的图片...`;
                    restoreTweetImages = await inlineImagesForCapture(tweet, scale);
                    notification.innerHTML = `正在截取 ${authorTweets.length} 张截图... (${percentage}%)`;

                    const blob = await withTimeout(
                        domtoimage.toBlob(tweet, config),
                        20000,
                        `第 ${i + 1} 条截图超时`
                    );
                    blobs.push(blob);
                } catch (screenshotError) {
                    console.error(`截取帖子 ${i + 1} 失败:`, screenshotError);
                    notification.innerHTML = `截取帖子 ${i + 1} 出错，已跳过。`;
                    await new Promise(resolve => setTimeout(resolve, 1500));
                } finally {
                    restoreTweetImages();
                }
            }

            if (blobs.length === 0) {
                throw new Error("未成功截取任何截图。");
            }

            notification.innerHTML = `正在拼接 ${blobs.length} 张截图...`;

            // 5. 使用 Canvas 拼接图片
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            let totalHeight = 0;
            let maxWidth = 0;
            const images = [];

            for (const blob of blobs) {
                const img = new Image();
                const url = URL.createObjectURL(blob);
                img.src = url;
                await new Promise(resolve => { img.onload = resolve; });
                images.push(img);
                totalHeight += img.height;
                maxWidth = Math.max(maxWidth, img.width);
            }

            canvas.width = maxWidth;
            canvas.height = totalHeight;

            let currentY = 0;
            for (const img of images) {
                ctx.drawImage(img, 0, currentY);
                currentY += img.height;
                URL.revokeObjectURL(img.src);
            }

            // 6. 获取最终图片并处理
            canvas.toBlob(function(finalBlob) {
                navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': finalBlob })
                ]).then(() => {
                    notification.innerHTML = `
                        <div>帖子串截图已复制！(${images.length} 篇帖子)</div>
                        <button class="download-btn" style="background: white; color: #1DA1F2; border: none; padding: 5px 10px; border-radius: 15px; margin-top: 5px; cursor: pointer;">下载</button>
                    `;
                    notification.style.backgroundColor = '#17BF63';

                    const downloadBtn = notification.querySelector('.download-btn');
                    downloadBtn.addEventListener('click', () => {
                        const link = document.createElement('a');
                        link.download = `twitter-thread-${authorHandle.substring(1)}-${Date.now()}.png`;
                        link.href = URL.createObjectURL(finalBlob);
                        link.click();
                        URL.revokeObjectURL(link.href);
                        setTimeout(() => {
                            notification.classList.add('fade-out');
                            setTimeout(() => notification.remove(), 500);
                        }, 1500);
                    });

                    setTimeout(() => {
                        if (!notification.classList.contains('fade-out')) {
                            notification.classList.add('fade-out');
                            setTimeout(() => notification.remove(), 500);
                        }
                    }, 4000);
                }).catch(err => {
                    console.error('复制拼接图片失败:', err);
                    notification.textContent = '复制帖子串截图失败。';
                    notification.style.backgroundColor = '#E0245E';
                    setTimeout(() => notification.remove(), 3000);
                });

            }, 'image/png', 0.9);

        } catch (error) {
            console.error('截取帖子串失败:', error);
            notification.textContent = `截取帖子串失败: ${error.message}`;
            notification.style.backgroundColor = '#E0245E';
            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => notification.remove(), 500);
            }, 3000);
        }
    }

    function extractTweetText(article) {
        const textElement = article.querySelector('[data-testid="tweetText"]');
        if (!textElement) return '';

        const clone = textElement.cloneNode(true);
        const showMoreBtn = clone.querySelector('button[data-testid="tweet-text-show-more-link"]');
        if (showMoreBtn) showMoreBtn.remove();

        const emojiImgs = clone.querySelectorAll('img[alt]');
        emojiImgs.forEach(img => {
            const alt = img.getAttribute('alt');
            if (alt) {
                img.replaceWith(document.createTextNode(alt));
            }
        });

        return (clone.innerText || clone.textContent || '').trim();
    }

    function extractTweetUrl(article) {
        let tweetUrl = '';
        const timeElement = article.querySelector('time');
        if (timeElement) {
            const anchor = timeElement.closest('a');
            if (anchor && anchor.href) {
                tweetUrl = anchor.href;
            }
        }
        if (!tweetUrl) {
            const statusLink = article.querySelector('a[href*="/status/"]');
            if (statusLink && statusLink.href) {
                tweetUrl = statusLink.href;
            }
        }
        if (!tweetUrl) {
            tweetUrl = window.location.href;
        }

        const match = tweetUrl.match(/(https?:\/\/[^\/]+\/[^\/]+\/status\/\d+)/);
        if (match) {
            tweetUrl = match[1];
        } else {
            tweetUrl = tweetUrl.split('?')[0];
        }
        return tweetUrl;
    }

    async function copyTweet(menuButton) {
        const notification = document.createElement('div');
        notification.className = 'screenshot-notification';
        notification.innerHTML = '正在复制帖子...';
        document.body.appendChild(notification);

        try {
            const article = findTweetMainContent(menuButton);
            if (!article) {
                throw new Error('未找到帖子内容');
            }

            const showMoreBtn = article.querySelector('button[data-testid="tweet-text-show-more-link"]');
            if (showMoreBtn) {
                showMoreBtn.click();
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            const tweetText = extractTweetText(article);
            const tweetUrl = extractTweetUrl(article);

            let contentToCopy = '';
            if (tweetText && tweetUrl) {
                contentToCopy = `${tweetText}\n\n${tweetUrl}`;
            } else if (tweetText) {
                contentToCopy = tweetText;
            } else if (tweetUrl) {
                contentToCopy = tweetUrl;
            } else {
                throw new Error('未找到可复制的文本或链接');
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(contentToCopy);
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = contentToCopy;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }

            notification.textContent = '帖子已连同链接复制！';
            notification.style.backgroundColor = '#17BF63';
            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => notification.remove(), 500);
            }, 1500);
        } catch (error) {
            console.error('复制帖子失败:', error);
            notification.textContent = `复制失败: ${error.message}`;
            notification.style.backgroundColor = '#E0245E';
            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => notification.remove(), 500);
            }, 2000);
        }
    }

    // 把帖子页面里的图片地址规范化为原图地址；返回 null 表示该地址不可下载
    function normalizeTweetImageUrl(src) {
        if (!src) return null;
        // 跳过 data: 与 blob: 地址，GM_download 只接受 http(s) 地址
        if (!/^https?:\/\//i.test(src)) return null;
        let url = src;
        if (/[?&]name=/i.test(url)) {
            // 形如 https://pbs.twimg.com/media/XXX.jpg?name=small
            // 或   https://pbs.twimg.com/media/XXX?format=jpg&name=small
            url = url.replace(/([?&])name=[^&#]*/i, '$1name=orig');
        } else if (/:(small|medium|large|thumb)([?#]|$)/i.test(url)) {
            // 形如 https://pbs.twimg.com/media/XXX.jpg:small，去掉裁剪后缀即为原图
            url = url.replace(/:(small|medium|large|thumb)([?#]|$)/i, '$2');
        } else if (/^https:\/\/pbs\.twimg\.com\/media\//i.test(url)) {
            // 无尺寸参数的 media 链接补上 name=orig
            url += (url.includes('?') ? '&' : '?') + 'name=orig';
        }
        return url;
    }

    // 收集这条帖子内的图片地址；视频与 GIF 的容器内含 video 元素，会被跳过
    function collectImageUrls(article) {
        const urls = [];
        const seen = new Set();
        article.querySelectorAll('[data-testid="tweetPhoto"]').forEach(container => {
            if (container.querySelector('video')) return;
            const img = container.querySelector('img');
            if (!img) return;
            const url = normalizeTweetImageUrl(img.src);
            if (url && !seen.has(url)) {
                seen.add(url);
                urls.push(url);
            }
        });
        return urls;
    }

    // 逐张下载这条帖子的图片到浏览器下载文件夹
    async function downloadImages(menuButton) {
        const notification = document.createElement('div');
        notification.className = 'screenshot-notification';
        document.body.appendChild(notification);

        try {
            if (typeof GM_download !== 'function') {
                throw new Error('GM_download 不可用，请确认脚本安装在 Tampermonkey 或 Violentmonkey 中并已允许下载权限');
            }

            const article = findTweetMainContent(menuButton);
            if (!article) {
                throw new Error('未找到帖子内容');
            }

            const urls = collectImageUrls(article);
            if (urls.length === 0) {
                throw new Error('这条帖子没有可下载的图片');
            }

            // 文件名使用帖子 ID，与页面上的状态链接保持一致
            let idLabel = String(Date.now());
            const idMatch = extractTweetUrl(article).match(/\/status\/(\d+)/);
            if (idMatch) {
                idLabel = idMatch[1];
            }

            notification.style.backgroundColor = '#1DA1F2';
            notification.textContent = `正在下载 ${urls.length} 张图片...`;

            let done = 0;
            let failed = 0;
            for (let i = 0; i < urls.length; i++) {
                notification.textContent = `正在下载第 ${i + 1}/${urls.length} 张图片...`;
                const url = urls[i];
                const extMatch = url.match(/\.(jpe?g|png|webp|bmp)(?:[?#]|$)/i);
                let ext = 'jpg';
                if (extMatch) {
                    ext = extMatch[1].toLowerCase();
                    if (ext === 'jpeg') ext = 'jpg';
                }
                const ok = await new Promise((resolve) => {
                    GM_download({
                        url: url,
                        name: `twitter-${idLabel}-${i + 1}.${ext}`,
                        onload: () => resolve(true),
                        onerror: (error) => {
                            console.error('图片下载失败:', url, error);
                            resolve(false);
                        }
                    });
                });
                if (ok) { done++; } else { failed++; }
                // 逐张触发之间留出间隔，避免浏览器拦截连续多文件下载
                if (i < urls.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 600));
                }
            }

            if (failed === 0) {
                notification.textContent = `已下载 ${done} 张图片`;
                notification.style.backgroundColor = '#17BF63';
            } else if (done > 0) {
                notification.textContent = `已下载 ${done} 张，${failed} 张失败`;
                notification.style.backgroundColor = '#F7B928';
            } else {
                notification.textContent = '图片下载失败，请在地址栏允许下载多个文件后重试';
                notification.style.backgroundColor = '#E0245E';
            }
            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => notification.remove(), 500);
            }, 2500);
        } catch (error) {
            console.error('批量下载图片失败:', error);
            notification.textContent = `下载图片失败: ${error.message}`;
            notification.style.backgroundColor = '#E0245E';
            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => notification.remove(), 500);
            }, 3000);
        }
    }

    function createImagesIcon() {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("xmlns", svgNS);
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "18.75");
        svg.setAttribute("height", "18.75");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.classList.add("screenshot-icon");

        // Feather Icons: download
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4");
        const polyline = document.createElementNS(svgNS, "polyline");
        polyline.setAttribute("points", "7 10 12 15 17 10");
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", "12");
        line.setAttribute("y1", "15");
        line.setAttribute("x2", "12");
        line.setAttribute("y2", "3");

        svg.appendChild(path);
        svg.appendChild(polyline);
        svg.appendChild(line);
        return svg;
    }

    function createCopyIcon() {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("xmlns", svgNS);
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "18.75");
        svg.setAttribute("height", "18.75");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.classList.add("screenshot-icon");

        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", "9");
        rect.setAttribute("y", "9");
        rect.setAttribute("width", "13");
        rect.setAttribute("height", "13");
        rect.setAttribute("rx", "2");
        rect.setAttribute("ry", "2");

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");

        svg.appendChild(rect);
        svg.appendChild(path);
        return svg;
    }

    function addScreenshotButtonToMenu(menuButton) {
        const menu = document.querySelector('[role="menu"]');
        if (!menu || menu.querySelector('.copy-post-button') || menu.querySelector('.screenshot-button') || menu.querySelector('.download-images-button') || menu.querySelector('.capture-thread-button')) return;

        // --- 复制帖子按钮 ---
        const copyButton = document.createElement('div');
        copyButton.className = 'screenshot-button copy-post-button';
        copyButton.setAttribute('role', 'menuitem');
        copyButton.setAttribute('tabindex', '0');

        copyButton.appendChild(createCopyIcon());

        const textCopy = document.createElement('span');
        textCopy.textContent = '复制帖子';
        textCopy.style.marginLeft = '12px';
        textCopy.style.fontSize = '15px';
        textCopy.style.fontWeight = 'bold';
        copyButton.appendChild(textCopy);

        copyButton.addEventListener('click', (event) => {
            event.stopPropagation();
            copyTweet(menuButton);
            setTimeout(() => {
                const closeButton = document.querySelector('[data-testid="Dropdown"] [aria-label="Close"]');
                if (closeButton) closeButton.click();
            }, 100);
        });

        // --- 截图按钮 ---
        const screenshotButton = document.createElement('div');
        screenshotButton.className = 'screenshot-button';
        screenshotButton.setAttribute('role', 'menuitem');
        screenshotButton.setAttribute('tabindex', '0');

        screenshotButton.appendChild(createScreenshotIcon());

        const textScreenshot = document.createElement('span');
        textScreenshot.textContent = '截图';
        textScreenshot.style.marginLeft = '12px';
        textScreenshot.style.fontSize = '15px';
        textScreenshot.style.fontWeight = 'bold';
        screenshotButton.appendChild(textScreenshot);

        screenshotButton.addEventListener('click', (event) => {
            event.stopPropagation();
            takeScreenshot(menuButton);
            setTimeout(() => {
                const closeButton = document.querySelector('[data-testid="Dropdown"] [aria-label="Close"]');
                if (closeButton) closeButton.click();
            }, 100);
        });

        // --- 截取帖子串按钮 ---
        const captureThreadButton = document.createElement('div');
        captureThreadButton.className = 'screenshot-button capture-thread-button';
        captureThreadButton.setAttribute('role', 'menuitem');
        captureThreadButton.setAttribute('tabindex', '0');

        captureThreadButton.appendChild(createThreadIcon());

        const textThread = document.createElement('span');
        textThread.textContent = '截取帖子串';
        textThread.style.marginLeft = '12px';
        textThread.style.fontSize = '15px';
        textThread.style.fontWeight = 'bold';
        captureThreadButton.appendChild(textThread);

        captureThreadButton.addEventListener('click', (event) => {
            event.stopPropagation();
            captureThread(menuButton);
            setTimeout(() => {
                const closeButton = document.querySelector('[data-testid="Dropdown"] [aria-label="Close"]');
                if (closeButton) closeButton.click();
            }, 100);
        });

        // --- 下载图片按钮 ---
        const downloadImageButton = document.createElement('div');
        downloadImageButton.className = 'screenshot-button download-images-button';
        downloadImageButton.setAttribute('role', 'menuitem');
        downloadImageButton.setAttribute('tabindex', '0');

        downloadImageButton.appendChild(createImagesIcon());

        const textDownload = document.createElement('span');
        textDownload.textContent = '下载图片';
        textDownload.style.marginLeft = '12px';
        textDownload.style.fontSize = '15px';
        textDownload.style.fontWeight = 'bold';
        downloadImageButton.appendChild(textDownload);

        downloadImageButton.addEventListener('click', (event) => {
            event.stopPropagation();
            downloadImages(menuButton);
            setTimeout(() => {
                const closeButton = document.querySelector('[data-testid="Dropdown"] [aria-label="Close"]');
                if (closeButton) closeButton.click();
            }, 100);
        });

        // 按顺序在菜单顶部插入按钮：复制帖子、截图、下载图片、截取帖子串
        menu.insertBefore(captureThreadButton, menu.firstChild);
        menu.insertBefore(downloadImageButton, captureThreadButton);
        menu.insertBefore(screenshotButton, menu.firstChild);
        menu.insertBefore(copyButton, menu.firstChild);
    }

    function addScreenshotButtons() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.addedNodes.length) {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) {
                            const menu = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]');
                            if (menu) {
                                const menuButton = document.querySelector('[aria-haspopup="menu"][aria-expanded="true"]');
                                if (menuButton && menuButton.closest('article[role="article"]') && menuButton.getAttribute('data-testid') === 'caret') {
                                    addScreenshotButtonToMenu(menuButton);
                                }
                            }
                        }
                    });
                }
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    addScreenshotButtons();
})();
