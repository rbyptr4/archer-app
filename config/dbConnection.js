const mongoose = require('mongoose');

const connectDb = async () => {
  try {
    if (!process.env.CONNECTION_STRING) {
      throw new Error('CONNECTION_STRING is not defined in .env file!');
    }

    const connect = await mongoose.connect(process.env.CONNECTION_STRING);
    console.log(
      'Database connected : ',
      connect.connection.host,
      connect.connection.name
    );
  } catch (err) {
    console.log(process.env.CONNECTION_STRING);

    console.log(err);
    process.exit(1);
  }
};

module.exports = connectDb;
