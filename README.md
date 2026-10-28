# userscripts-personal

个人 userscript 集合，所有脚本都在浏览器本地运行，不依赖外部服务器。

## 脚本列表

### x-top3-comments.user.js

在 X（Twitter）页面展示推文的前三条回复，样式参考信息流里的评论预览。

- **首页时间线**：每条推文下方显示「收起回复 ^」面板，展示该推文的前三条直接回复
- **单条推文页**：在主推文下方展示同样的面板，原生回复列表保持不变
- **懒加载**：只有接近视口的推文才会请求回复，滚动到哪条加载哪条
- **节流与重试**：请求间隔 1.5 秒；失败可点「重试」；遇到 429 自动冷却 30 秒
- **主题自适应**：跟随 X 的亮色/暗色主题
- **可折叠**：点击「收起回复 ^ / 展开回复 v」切换显示

#### 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开安装链接：
   https://raw.githubusercontent.com/tszlznl/userscripts-personal/master/x-top3-comments.user.js
3. 在脚本管理器中确认安装

#### 说明与限制

- 需要登录 X；回复通过 X 网页端的 GraphQL `TweetDetail` 接口获取，queryId 与 Bearer 在运行时从页面 bundle 提取
- 依赖 X 的页面结构，X 改版后可能需要更新
- 展示的是 X「相关性」排序的前三条直接回复，顺序可能与推文页原生回复列表略有不同
- X 接口有限流；脚本只对接近视口的推文发起请求，并做了 1.5 秒节流
- 「（媒体内容）」表示该回复没有文字、只有图片或视频
- 被 X「显示更多」截断的长回复不会自动展开

#### 隐私

- 不向第三方服务器发送数据；所有请求都发往 x.com，并复用当前浏览器的登录态
- 回复缓存只保存在页面内存和 sessionStorage 中，刷新后重新获取

### telegram-media-downloader.user.js

从禁止下载的 Telegram Web 频道下载图片、视频和语音消息。

- 来源：[Neet-Nestor/Telegram-Media-Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader)（作者 Nestor Qin，GPLv3）
- 安装：https://raw.githubusercontent.com/tszlznl/userscripts-personal/master/telegram-media-downloader.user.js

### twitter-x-post-toolbar.user.js

在 X/Twitter 的帖子菜单中增加截图、复制、批量下载图片和截取整个帖子串的按钮。

- 来源：Greasy Fork「Twitter Screenshot Button」（脚本 532781，MIT）
- 安装：https://raw.githubusercontent.com/tszlznl/userscripts-personal/master/twitter-x-post-toolbar.user.js

## 提交约定

- 每个脚本一个 `.user.js` 文件放在仓库根目录，脚本多了再按目录拆分
- 提交信息使用 `type(scope): summary`，例如 `feat(userscript): 添加 ...`
