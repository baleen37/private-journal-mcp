import { encodeFrame, FrameDecoder } from '../src/embedding-protocol';

describe('embedding protocol', () => {
  it('decodes a request split across arbitrary socket chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ id: 'a', type: 'status' });

    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ id: 'a', type: 'status' }]);
  });
});
