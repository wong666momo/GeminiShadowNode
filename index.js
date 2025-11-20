import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 240000; // 4分钟超时

const app = express();
const server = http.createServer(app);

// 【关键修改 1】设置 WebSocket 最大负载
// 默认是 100MB。我们把它改为 512MB (单位是字节)
const MAX_PAYLOAD = 512 * 1024 * 1024; 
const wss = new WebSocketServer({ 
  server, 
  path: '/ws',
  maxPayload: MAX_PAYLOAD // <--- 这一行非常重要！防止大包导致断连
});

let appletSocket = null;
const pendingRequests = new Map();

// =================================================================
// 心跳检测逻辑 (核心修改区域)
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
    if (pendingRequests.size > 0) {
        console.log(`⚠️ 心跳未响应，但当前有 ${pendingRequests.size} 个任务正在运行。保持连接活跃，暂不断开...`);
        // 给予豁免，不 terminate，并在下一轮继续发送 ping 尝试唤醒或维持 NAT
        // 这里不重置 isAlive，保持 false 状态，直到收到 pong 或 任务列表清空
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
      if (!e.message.includes('Unexpected token P')) {
          console.error('⚠️ 收到非标准消息 (已忽略):', e.message);
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
app.use(express.json({ limit: '512mb' })); 
app.use(express.urlencoded({ limit: '512mb', extended: true }));

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'running',
    appletConnected: !!appletSocket,
    pendingTasks: pendingRequests.size // 显示当前排队数
  });
});

app.post('/v1beta/*', (req, res) => {
  if (!appletSocket) {
    return res.status(503).json({ error: { code: 503, message: 'Service Unavailable: No Applet Connected', status: 'UNAVAILABLE' } });
  }
  
  const id = crypto.randomUUID();
  const path = req.originalUrl; 
  
  // HTTP 层的超时控制
  // 如果 Applet 真的死机了，这个超时会触发，清空 pendingRequests
  // 下一次心跳检测发现 pendingRequests 为空且无心跳，就会杀掉 WebSocket
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