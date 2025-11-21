# 🚀 Gemini 中转服务器 (Relay Server) 部署指南 (终极版)

这个文件包含了使用 Node.js、Express 和 `ws` 库实现中转服务器的完整代码。

## 核心功能

- **通用 HTTP 代理**: 暴露 `/v1beta/*` 通配符端点。它捕获任何 Gemini API 请求（包括模型名称、生成配置、系统指令等）并按原样转发。
- **WebSocket 服务器**: 在 `/ws` 路径上启动一个 WebSocket 服务器，等待安全的 Applet 客户端连接。
- **透明转发**: 将 HTTP 请求的 **路径 (Path)** 和 **请求体 (Body)** 打包并通过 WebSocket 发送给 Applet。
- **响应匹配**: 使用唯一的请求 ID 来匹配从 Applet 返回的响应，并将其作为 HTTP 响应发送回给原始请求者。

---

## 📋 准备工作

1.  你需要一台 **Linux 服务器** (推荐 Ubuntu/Debian)。
2.  你需要 **Root 权限** (或者使用 `sudo`)。
3.  确保服务器已安装 **Node.js** (建议 v18 或更高版本)。

> **还没有安装 Node.js?**
> 请运行：`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`

---

## 第一步：创建项目目录

我们将把代码放在 `/root/gemini-relay` 目录下（你可以放在别处，但请记住路径）。

在终端中依次执行：

```bash
# 1. 创建文件夹
mkdir -p /root/gemini-relay

# 2. 进入文件夹
cd /root/gemini-relay

# 3. 初始化项目 (一路回车即可)
npm init -y

# 4. 安装必要的依赖库
npm install express ws cors
```

---

## 第二步：写入服务器代码
1.  创建文件：
    ```bash
    nano index.js
    ```

2.  **完整复制**以下代码并粘贴进去：

```javascript
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 240000; // 4分钟超时，给视频生成留足时间

const app = express();
const server = http.createServer(app);

// 【关键修改 1】设置 WebSocket 最大负载
// 默认是 100MB。我们把它改为 512MB (单位是字节) 以支持大视频/图片
const MAX_PAYLOAD = 512 * 1024 * 1024; 
const wss = new WebSocketServer({ 
  server, 
  path: '/ws',
  maxPayload: MAX_PAYLOAD 
});

let appletSocket = null;
const pendingRequests = new Map();

// =================================================================
// 心跳检测逻辑 (智能豁免版)
// =================================================================
function heartbeat() {
  this.isAlive = true;
}

const interval = setInterval(function ping() {
  // 如果没有连接，跳过
  if (!appletSocket) return;

  const ws = appletSocket;
  
  // 检查连接状态
  if (ws.isAlive === false) {
    // 【关键修改】: 检查是否有正在处理的请求
    // 如果正在生成任务，Applet 可能没空回心跳，此时给予“豁免权”
    if (pendingRequests.size > 0) {
        console.log(`⚠️ 心跳未响应，但当前有 ${pendingRequests.size} 个任务正在运行。保持连接活跃，暂不断开...`);
        ws.ping(); 
        return;
    }

    // 只有在既没有心跳，又没有任务的时候，才认为是真的挂了
    console.log('💀 心跳超时且无活动任务，判定为连接断开，正在终止...');
    return ws.terminate();
  }

  // 标记为 false，准备发送 Ping
  ws.isAlive = false;
  ws.ping(); 
}, 30000); // 30秒一次心跳

wss.on('close', () => {
  clearInterval(interval);
});

// =================================================================
// WebSocket 连接处理
// =================================================================
wss.on('connection', (ws) => {
  console.log('✅ 安全执行节点 (Applet) 已连接!');
  
  ws.isAlive = true;
  ws.on('pong', heartbeat); 

  appletSocket = ws;

  ws.on('message', (message) => {
    // 只要收到消息，就视为活着
    ws.isAlive = true;

    try {
      const msgString = message.toString();
      
      // 忽略纯文本心跳
      if (msgString.trim().toLowerCase().startsWith('p')) {
        return;
      }

      const { id, success, payload, error } = JSON.parse(msgString);
      
      if (pendingRequests.has(id)) {
        const { res, timeoutId } = pendingRequests.get(id);
        clearTimeout(timeoutId); // 停止 HTTP 超时计时器
        
        if (success) {
          res.json(payload);
        } else {
          res.status(500).json({ error: { code: 500, message: error || 'Unknown error', status: 'INTERNAL_ERROR' } });
        }
        pendingRequests.delete(id); // 任务完成，从队列移除
      }
    } catch (e) {
      // 忽略非JSON的干扰信息
      if (!e.message.includes('Unexpected token')) {
          console.error('⚠️ 收到非标准消息:', e.message);
      }
    }
  });

  ws.on('close', () => {
    console.log('❌ 安全执行节点 (Applet) 已断开.');
    if (appletSocket === ws) {
        appletSocket = null;
    }
    // 只有连接彻底断开时，才报错所有挂起的请求
    for (const [id, { res, timeoutId }] of pendingRequests.entries()) {
      clearTimeout(timeoutId);
      res.status(503).json({ error: { code: 503, message: 'Execution node disconnected.', status: 'UNAVAILABLE' } });
      pendingRequests.delete(id);
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket 错误:', err);
  });
});

// =================================================================
// Express HTTP 服务器
// =================================================================

app.use(cors());
// 【关键修改 2】放开 HTTP JSON 大小限制
app.use(express.json({ limit: '512mb' })); 
app.use(express.urlencoded({ limit: '512mb', extended: true }));

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'running',
    appletConnected: !!appletSocket,
    pendingTasks: pendingRequests.size
  });
});

app.post('/v1beta/*', (req, res) => {
  if (!appletSocket) {
    return res.status(503).json({ error: { code: 503, message: 'Service Unavailable: No Applet Connected', status: 'UNAVAILABLE' } });
  }
  
  const id = crypto.randomUUID();
  const path = req.originalUrl; 
  
  // HTTP 层的超时控制
  const timeoutId = setTimeout(() => {
    if (pendingRequests.has(id)) {
      console.log(`⏰ 任务 [${id}] 超时 (${REQUEST_TIMEOUT}ms)`);
      res.status(504).json({ error: { code: 504, message: 'Gateway Timeout', status: 'DEADLINE_EXCEEDED' } });
      pendingRequests.delete(id);
    }
  }, REQUEST_TIMEOUT);

  pendingRequests.set(id, { res, timeoutId });

  const message = JSON.stringify({ id, path, body: req.body });
  appletSocket.send(message);
});

server.listen(PORT, () => {
  console.log(`🚀 服务器运行中: http://localhost:${PORT}`);
});
```

3.  **保存退出**：按 `Ctrl+O` -> `Enter` -> `Ctrl+X`。

4.  **修改 package.json** (开启 ES Module 支持)：
    运行命令：
    ```bash
    npm pkg set type="module"
    ```


---

## 第三步：配置 Systemd (开机自启与守护)

我们不直接用 `npm start` 跑，因为那样只要你关掉 SSH 窗口，服务就停了。我们要用 Systemd 把它变成像 Nginx 一样的系统服务。

1.  **查找 npm 路径**：
    运行 `which npm`。通常是 `/usr/bin/npm`。如果你的不一样，请替换下面配置中的路径。

2.  **创建服务文件**：
    ```bash
    sudo nano /etc/systemd/system/gemini-relay.service
    ```

3.  **粘贴配置**：

```ini
[Unit]
Description=Gemini Relay Server (Shadow Node Backend)
After=network.target

[Service]
# 服务类型
Type=simple
# 运行用户 (root)
User=root
# 项目所在目录 (请确保和第一步一致)
WorkingDirectory=/root/gemini-relay
# 启动命令 (注意路径)
ExecStart=/usr/bin/npm start
# 崩溃自动重启
Restart=always
RestartSec=10
# 环境变量
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

4.  **启动并设为开机自启**：

```bash
# 重载配置
sudo systemctl daemon-reload
# 启动服务
sudo systemctl start gemini-relay
# 设为开机自启
sudo systemctl enable gemini-relay
```

5.  **验证状态**：
    ```bash
    sudo systemctl status gemini-relay
    ```
    如果你看到绿色的 **`active (running)`**，说明配置成功！

---

## 第四步：配置 Nginx (HTTPS 与 大文件支持)

如果不配置 Nginx，你只能用 `http://IP:3000`，这不安全且 Applet 无法连接（因为 Applet 在 HTTPS 环境下必须连 WSS）。

1.  **编辑你的 Nginx 站点配置** (假设你的域名已配置好 SSL)：
    ```bash
    sudo nano /etc/nginx/sites-available/your-site # 替换为你的站点配置文件
    ```

2.  **确保包含以下核心配置** (特别是 WebSocket 支持和大小限制)：

```nginx
server {
    listen 443 ssl;
    server_name your-site; # 替换为你的域名

    # ... SSL 证书配置 ...

    # 【关键 1】允许上传大文件 (如视频/图片)
    client_max_body_size 512m;

    # 1. 转发 WebSocket (/ws)
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        
        # WebSocket 协议升级头 (必须!)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 传递真实 IP
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 超时设置 (防止生成视频时长连接断开)
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 2. 转发 API 请求 (/v1beta)
    location /v1beta/ {
        proxy_pass http://127.0.0.1:3000;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 同样需要长超时
        proxy_read_timeout 300s;
    }
    
    # ... 其他配置 ...
}
```

3.  **测试并重载 Nginx**：
    ```bash
    sudo nginx -t
    sudo systemctl reload nginx
    ```

---

## 📝 常用维护命令

现在，你的服务器已经完全自动化了。以下是一些常用命令：

*   **查看实时日志** (查看 Applet 连接状态、报错等)：
    ```bash
    journalctl -u gemini-relay -f
    ```
    *(按 `Ctrl+C` 退出)*

*   **重启服务** (如果你修改了 `index.js` 代码)：
    ```bash
    sudo systemctl restart gemini-relay
    ```

*   **停止服务**：
    ```bash
    sudo systemctl stop gemini-relay
    ```

---

## 🎉 部署完成

现在，你的中转服务器已经：
1.  **支持 512MB 大数据包**（视频/高清图无压力）。
2.  **智能防断连**（生成任务时不会因心跳超时被杀）。
3.  **全自动运行**（VPS 重启后自动复活）。
4.  **安全加密**（通过 Nginx 走 HTTPS/WSS）。

现在去你的 Applet 里填入 `wss://your-site/ws`，即可享受丝滑的 Gemini 服务！