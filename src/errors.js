export class FolioError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'FolioError';
    this.code = code;
    this.details = details;
  }
}

/** A write lost a race: the file changed (or already exists) since it was read. */
export class ConflictError extends FolioError {
  constructor(path, message) {
    super('conflict', message || `Conflict writing ${path}: it changed since it was read`, { path });
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends FolioError {
  constructor(what) {
    super('not_found', `${what} was not found`, { what });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends FolioError {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [problems];
    super('invalid', list.map((p) => (typeof p === 'string' ? p : p.message)).join('; '), { problems: list });
    this.name = 'ValidationError';
    this.problems = list;
  }
}
