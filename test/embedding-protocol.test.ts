import { encodeFrame, FrameDecoder } from '../src/embedding-protocol';

describe('embedding protocol', () => {
  it('decodes a request split across arbitrary socket chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ id: 'a', type: 'status' });

    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ id: 'a', type: 'status' }]);
  });

  it('rejects a frame larger than the protocol limit before buffering its body', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2 * 1024 * 1024, 0);

    expect(() => decoder.push(header)).toThrow('frame exceeds maximum size');
  });
});
