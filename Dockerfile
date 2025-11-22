# 使用一个官方的、轻量的 Node.js 18 镜像
FROM node:18-slim

# 在容器内设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 文件进去
# 只复制这一个文件是为了利用 Docker 的缓存机制
COPY package.json ./

# 安装运行所必需的依赖包，并忽略开发依赖
RUN npm install --omit=dev

# 将项目里的所有其他文件复制进去
COPY . .

# Koyeb 会自动注入 PORT 环境变量，这里只是声明一下
EXPOSE 8080

# 容器启动时运行的命令
CMD [ "node", "server.js" ]
