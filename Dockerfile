FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Run Python unit tests, regenerate all benchmark CSVs/JSONs/figures, and verify TypeScript build
RUN make reproduce && npm run build

EXPOSE 3000
CMD ["npm", "run", "dev"]
