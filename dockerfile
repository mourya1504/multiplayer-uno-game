FROM node:20-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer
COPY package*.json ./
RUN npm install

# Copy the rest of the project
COPY . .

EXPOSE 3000

# Use nodemon so the server restarts when you edit server.js
RUN npm install -g nodemon

CMD ["nodemon", "server.js"]