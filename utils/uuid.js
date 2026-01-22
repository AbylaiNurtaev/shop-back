const { v4: uuidv4 } = require('uuid');

function generateId() {
  return uuidv4();
}

module.exports = { generateId };
