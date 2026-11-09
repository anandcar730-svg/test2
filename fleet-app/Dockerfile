FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TZ=Asia/Kolkata
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
