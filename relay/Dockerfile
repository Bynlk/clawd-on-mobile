FROM node:20-alpine

WORKDIR /app

# 复制依赖文件
COPY package.json ./

# 安装依赖
RUN npm install --production

# 复制服务器代码
COPY relay-server.js ./

# 暴露端口
EXPOSE 7891

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:7891/health || exit 1

# 启动
CMD ["node", "relay-server.js"]
