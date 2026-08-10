```javascript
const { describe, it, expect } = require('@jest/globals');
const fastify = require('fastify');
const { Pool } = require('pg');
const { validatePassword } = require('./passwordValidator'); // assuming password validator is in a separate file

describe('E2E Verification Run for Contract AC-MSN656ZE-9A1FF9', () => {
  let app, pgPool;

  beforeEach(async () => {
    app = fastify();
    pgPool = new Pool({
      user: 'your_username',
      host: 'your_host',
      database: 'your_database',
      password: 'your_password',
      port: 5432,
    });
    await app.register(require('fastify-postgres'), {
      pgPool,
    });
    await app.register(require('fastify-jwt'), {
      secret: 'your_secret',
    });
    await app.register(require('fastify-owasp-security'), {
      rules: [
        // implement OWASP 2025 security compliance rules here
      ],
    });
    await app.get('/verify', {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
          },
        },
      },
      handler: async (request, reply) => {
        const { username, password } = request.body;
        const isValid = await validatePassword(username, password);
        if (isValid) {
          return { message: 'Valid credentials' };
        } else {
          return { message: 'Invalid credentials' };
        }
      },
    });
  });

  afterEach(async () => {
    await pgPool.end();
    await app.close();
  });

  it('Happy path: basic functionality', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'johnDoe',
        password: 'password123',
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe('Valid credentials');
  });

  it('Edge case: empty input handling', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: '',
        password: '',
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('Invalid credentials');
  });

  it('Error scenario: invalid credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'johnDoe',
        password: 'wrongPassword',
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe('Invalid credentials');
  });
});
```

Note: This code assumes you have the necessary dependencies installed (`fastify`, `fastify-postgres`, `fastify-jwt`, `fastify-owasp-security`, and `jest`). Also, replace the placeholders (`your_username`, `your_host`, `your_database`, `your_password`, and `your_secret`) with the actual values for your PostgreSQL database and Fastify setup.