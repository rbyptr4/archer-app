const validate = (schema) => (req, res, next) => {
  const { value, error } = schema.validate(req.body, {
    abortEarly: false, // tetap kumpulkan semua error (meski kita kirim 1)
    stripUnknown: true, // buang field liar
    convert: true, // auto-convert tipe
    context: { role: req.user?.role } // aman untuk schema yang tak pakai role
  });

  if (error) {
    const first = error.details[0];
    const field = Array.isArray(first.path) ? first.path[0] : first.path;
    const errObj = new Error(first.message);
    errObj.statusCode = 400;
    errObj.field = field;
    return next(errObj);
  }

  req.body = value;
  next();
};

module.exports = validate;
