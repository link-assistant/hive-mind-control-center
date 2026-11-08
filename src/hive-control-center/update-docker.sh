#!/bin/bash

# Updates hive-mind and agent inside the running container,
# then restarts the bot by killing its process (the loop in start-bot.sh restarts it).
# Run this on the server. The container is never stopped.

CONTAINER=hive-mind

check_agent() {
  echo ">>> Checking agent --version ($1)..."
  if ! docker exec $CONTAINER bash -i -c 'agent --version'; then
    echo "!!! agent --version FAILED ($1)"
    return 1
  fi
}

check_agent "before any changes" || true

echo ">>> Fixing /home/box/.local permissions for box user..."
docker exec -u root $CONTAINER mkdir -p /home/box/.local/share /home/box/.local/state
docker exec -u root $CONTAINER chown -R box:box /home/box/.local

echo ">>> Updating hive-mind..."
docker exec $CONTAINER bash -i -c 'bun install -g @link-assistant/hive-mind'

check_agent "after hive-mind install"

echo ">>> Updating agent..."
docker exec $CONTAINER bash -i -c 'bun install -g @link-assistant/agent'

check_agent "after agent install"

echo ">>> Initializing Gemini CLI (run three times to create config)..."
docker exec $CONTAINER bash -i -c 'gemini --version' || true
docker exec $CONTAINER bash -i -c 'gemini --version' || true
docker exec $CONTAINER bash -i -c 'gemini --version' || true

echo ">>> Restarting bot (killing current process, loop will restart it)..."
docker exec $CONTAINER pkill -f hive-telegram-bot

sleep 5

echo ">>> Bot logs after restart:"
docker logs --tail 20 $CONTAINER

echo ">>> Done"
