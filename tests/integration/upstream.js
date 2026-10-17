import { createServer } from 'node:http';

// A controllable Responses endpoint. Report reads still go through the real
// host's persisted usage history and the packaged plugin's management routes.
export async function startUpstream() {
  let sequence = 0;
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    requests.push(body);
    const marker = JSON.stringify(body.input);
    if (marker.includes('INTEGRATION-failure')) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'integration_failure', message: 'Controlled integration failure' } }));
      return;
    }
    if (marker.includes('INTEGRATION-cancel')) {
      await new Promise((done) => setTimeout(done, 1500));
      if (response.destroyed) return;
    }
    const id = `resp_reports_integration_${++sequence}`;
    const output = body.generate === false ? [] : [{ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Controlled report integration response.', annotations: [] }] }];
    const value = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model || 'gpt-5.4', status: marker.includes('INTEGRATION-incomplete') ? 'incomplete' : 'completed', output, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } } };
    if (value.status === 'incomplete') value.incomplete_details = { reason: 'max_output_tokens' };
    if (body.stream === false) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const item = output[0];
    const events = [
      { type: 'response.created', response: { ...value, status: 'in_progress', output: [] } },
      ...(item ? [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', response_id: id, item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
        { type: 'response.output_text.done', response_id: id, item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text },
        { type: 'response.output_item.done', output_index: 0, item },
      ] : []),
      ...(value.status === 'incomplete' ? [] : [{ type: 'response.completed', response: value }]),
    ];
    for (const [sequence_number, event] of events.entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
    response.end(value.status === 'incomplete' ? '' : 'data: [DONE]\n\n');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  };
}
