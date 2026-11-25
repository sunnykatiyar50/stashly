// docker-compose.yml keeps the database on the /data volume whatever .env says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n');

test('the compose file pins SQLITE_PATH to the /data volume, so a relative path in .env cannot move the database', () => {
    // An "environment" entry takes precedence over env_file, which is what makes the pin hold
    assert.match(compose, /\n {4}environment:\n {6}SQLITE_PATH: \/data\/stashly\.sqlite\n/);
    assert.match(compose, /\n {6}- stashly-data:\/data\n/);
    // ... and it is the same place the image defaults to
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /SQLITE_PATH=\/data\/stashly\.sqlite/);
});
