#!/bin/sh
cd "$(dirname "$0")"
echo "Course app: http://localhost:4173"
exec node server.js
