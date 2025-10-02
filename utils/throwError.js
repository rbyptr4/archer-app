const throwError = (
  message,
  statusCode = 500,
  field = null,
  details = null
) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (field) error.field = field;
  if (details) error.details = details;
  throw error;
};

module.exports = throwError;
