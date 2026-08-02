"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrameDecoder = exports.MAX_FRAME_BYTES = exports.WORKER_WIRE_VERSION = void 0;
exports.encodeFrame = encodeFrame;
exports.WORKER_WIRE_VERSION = 1;
exports.MAX_FRAME_BYTES = 1024 * 1024;
function encodeFrame(value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}
class FrameDecoder {
    buffer = Buffer.alloc(0);
    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const frames = [];
        while (this.buffer.length >= 4) {
            const bodyLength = this.buffer.readUInt32BE(0);
            if (bodyLength > exports.MAX_FRAME_BYTES) {
                this.buffer = Buffer.alloc(0);
                throw new Error('frame exceeds maximum size');
            }
            if (this.buffer.length < bodyLength + 4) {
                break;
            }
            frames.push(JSON.parse(this.buffer.subarray(4, bodyLength + 4).toString('utf8')));
            this.buffer = this.buffer.subarray(bodyLength + 4);
        }
        return frames;
    }
}
exports.FrameDecoder = FrameDecoder;
