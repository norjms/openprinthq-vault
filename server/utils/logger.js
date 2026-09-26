const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const minLevel = LEVELS[currentLevel] !== undefined ? LEVELS[currentLevel] : LEVELS.info;

function pad(n) {
  return n < 10 ? '0' + n : n;
}

function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatMessage(level, tag, message, args) {
  const ts = getTimestamp();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  if (args && args.length > 0) {
    return [prefix, message, ...args];
  }
  return [prefix, message];
}

const logger = {
  debug(tag, message, ...args) {
    if (minLevel <= LEVELS.debug) {
      console.log(...formatMessage('debug', tag, message, args));
    }
  },

  info(tag, message, ...args) {
    if (minLevel <= LEVELS.info) {
      console.log(...formatMessage('info', tag, message, args));
    }
  },

  warn(tag, message, ...args) {
    if (minLevel <= LEVELS.warn) {
      console.warn(...formatMessage('warn', tag, message, args));
    }
  },

  error(tag, message, ...args) {
    if (minLevel <= LEVELS.error) {
      console.error(...formatMessage('error', tag, message, args));
    }
  },

  requestLogger(req, res, next) {
    // Only log API requests and uploads to avoid spamming for every tiny static chunk
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      return next();
    }

    const start = Date.now();
    const { method, originalUrl } = req;

    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const msg = `${method} ${originalUrl} ${status} (${duration}ms)`;

      if (status >= 500) {
        logger.error('HTTP', msg);
      } else if (status >= 400) {
        logger.warn('HTTP', msg);
      } else {
        logger.info('HTTP', msg);
      }
    });

    next();
  }
};

module.exports = logger;
