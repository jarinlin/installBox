# installBox

邀请制的 [InstaBox](https://instabox.sh) 机器空闲 30 分钟就会自动休眠，而且这个阈值锁在账号上，`instabox auto-suspend 0` 改不掉。这个 Worker 从 Cloudflare 外面每 9 分钟续一次官方的 activity lease，租约留 15 分钟，让 30 分钟的空闲计时攒不满。

续完会往 Telegram 发一条当前状态。5 台都成功、或者其中几台失败，都会发。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jarinlin/installBox)

点上面的按钮，用你自己的 Cloudflare 账号部署同一套 Worker。仓库需要保持公开，这个按钮才能克隆。

## 部署时要填的 4 个 Secret

| 名字 | 填什么 |
| --- | --- |
| `INSTABOX_API_KEY` | `ibk_` 开头的 API key，权限至少要有 `machines:write`。在 [InstaBox API Keys](https://instabox.sh) 创建 |
| `TOKEN` | 自己起的一串随机字符。之后所有地址都要带 `?token=` |
| `TELEGRAM_BOT_TOKEN` | 在 Telegram 找 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 拿到的 token |
| `TELEGRAM_CHAT_ID` | 先给这个机器人发一句 `/start`，浏览器打开 `https://api.telegram.org/bot<token>/getUpdates`，JSON 里的 `chat.id` 就是。群的 id 是负数 |

`LOG` 是存续租记录的 KV，点部署时会自动建，不用自己填 id。

部署完成后打开：

```text
https://<你的worker>.workers.dev/?token=<TOKEN>
```

返回里 `ok` 为 `true`、`telegram` 为 `sent`，就说明 机器续上了，Telegram 也发出去了。

## 它具体做什么

- 定时任务 `*/9 * * * *`：每 9 分钟跑一次
- 每次把租约重新设成 900 秒（15 分钟）。两次触发之间还叠着大约 6 分钟，某一次晚了或失败，不会马上开始计那 30 分钟
- `INSTABOX_MACHINE` 留空时，续这把 key 名下的全部机器
- 机器已经是休眠或关机时，先 `resume`（关机的再用 `start`），醒了再续租
- 每次续租都发 Telegram。成功会列每台机器的到期时间（北京时间）；有失败会写成 `2/5 成功`，并带上原因

机器要一直醒着才会一直计运行时间。暂停期间不计费，开着保活就等于放弃这件事。

## 地址

都要带 `?token=`。后面再加 `&format=text` 就是纯文本。

| 地址 | 作用 |
| --- | --- |
| `/` | 立刻续租一次，并按结果发 Telegram |
| `/status` | 看每台机器是运行还是休眠 |
| `/log` | 最近 48 条续租记录 |
| `/release` | 放掉租约。放掉之后，机器重新按 30 分钟空闲休眠 |

## 安全

API key、访问令牌和机器人 token 都放在 Cloudflare Secret 里，接口不会把它们返回出来。只知道 Worker 域名的人进不去。

`?token=` 在地址里。拿到这串字符的人可以续租、唤醒已经停掉的机器、看状态和日志，也可以调用 `/release` 让机器恢复休眠。他拿不到 API key，也拿不到机器人 token。这串字符出现在浏览器历史和聊天记录里之后，建议重新写一遍 `TOKEN`。

## 本地部署

```powershell
npx wrangler secret put INSTABOX_API_KEY
npx wrangler secret put TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```

不想每 9 分钟收一条 Telegram 时，把 `wrangler.toml` 里的 `INSTABOX_TG_MODE` 改成 `hourly`（同一小时只发一条）或 `off`。
