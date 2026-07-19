'use strict';

const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_MAX_DATA_BYTES = 4096;

function boundedData(value, maxBytes) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return value;
  }
  return {
    truncated: true,
    preview: Buffer.from(serialized, 'utf8').subarray(0, maxBytes).toString('utf8'),
  };
}

class EventRecorder {
  constructor({ maxEvents = DEFAULT_MAX_EVENTS, maxDataBytes = DEFAULT_MAX_DATA_BYTES } = {}) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new TypeError('maxEvents must be a positive integer.');
    }
    if (!Number.isInteger(maxDataBytes) || maxDataBytes < 1) {
      throw new TypeError('maxDataBytes must be a positive integer.');
    }
    this.maxEvents = maxEvents;
    this.maxDataBytes = maxDataBytes;
    this.events = [];
    this.droppedEvents = 0;
  }

  record(type, data = {}) {
    if (typeof type !== 'string' || type.length === 0) {
      throw new TypeError('event type must be a non-empty string.');
    }
    if (this.events.length >= this.maxEvents) {
      this.droppedEvents += 1;
      return null;
    }
    const event = {
      type,
      at: new Date().toISOString(),
      data: boundedData(data, this.maxDataBytes),
    };
    this.events.push(event);
    return event;
  }

  snapshot() {
    return {
      events: this.events.map((event) => ({ ...event })),
      droppedEvents: this.droppedEvents,
    };
  }
}

module.exports = {
  EventRecorder,
};
