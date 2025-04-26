#!/bin/sh

if [ ! -f /app/config/config.yml ]; then
  echo "No config.yml found, copying example config..."
  cp /app/config_example.yml /app/config/config.yml
fi

echo "Starting frigate_mqtt..."
node /app/main.js