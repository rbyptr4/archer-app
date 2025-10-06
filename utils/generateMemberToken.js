const generateMemberToken = (member) => {
  return jwt.sign(
    {
      sub: member._id.toString(),
      phone: member.phone,
      name: member.name
    },
    process.env.MEMBER_TOKEN_SECRET,
    { expiresIn: '6h' }
  );
};

module.export = generateMemberToken;
