const validateUser = require('../utils/validateUser')
const pool = require("../db");
const {hashPassword, comparePassword} = require('../utils/hashPassword');
const mail = require("../utils/mail");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const moment = require("moment");
const curDate = moment().format();
const { OAuth2Client } = require("google-auth-library");
const {generateAccessToken, generateRefreshToken} = require("../utils/generateToken");
const client = new OAuth2Client(process.env.CLIENT_ID);

const createAccount = async (req, res, next) => {
  const { username, password, email, fullname } = req.body;

  if (validateUser (req.body)) {
    const chkEmail = await pool.query("select * from users where email = $1", [
      email,
    ]);

    if (!chkEmail.rows[0]) {
      const hashedPassword = hashPassword(password)
      try {
        const results = await pool.query(
          "INSERT INTO users(username, password, email, fullname) VALUES($1, $2, $3, $4) returning *",
          [username, hashedPassword, email, fullname]
        );
        mail.signupMail(email, fullname.split(" ")[0]);
        res.status(200).json({
          status: "success",
          data: results.rows[0],
        });
      } catch (error) {
        res.status(500).json(error);
      }
    } else {
      res.status(500).json("Email is in use");
    }
  } else {
    res.status(500).json("Password must be greater than 5 characters.");
  }
}

const loginUser = async (req, res, next) => {
  const { email, password } = req.body;
  try {
    if (validateUser(req.body)) {
      const {rows: user} = await pool.query("select * from users where email = $1", [
        email,
      ]);

      if (user[0]) {
        const { password: dbPassword, user_id, email, username, fullname, roles } = user[0];

        if (comparePassword(password, dbPassword)) {
          const token = generateAccessToken({ id: user_id, roles });
          // const refreshToken = generateRefreshToken({ id: user_id })
          res.header("auth-token", token);
          res.status(200).json({
            token,
            user_id,
            email,
            username,
            fullname,
            roles,
            status: "Login successful 🔓",
          });
        } else {
          next(new Error("Email or password incorrect."));
        }
      } else {
        next(new Error("Email or password incorrect."));
      }
    } else {
      next(new Error("Invalid login"));
    }
  } catch (error) {
    next(new Error("Something went wrong."));
  }
}

const googleLogin = async (req, res) => {
  const { token } = req.body;

  if(!token) return res.status(401)

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.CLIENT_ID,
    });

    const { name, email, sub, given_name } = ticket.getPayload();

    try {
      await pool.query(
        `INSERT INTO users(google_id,username, email, fullname) 
        VALUES($1, $2, $3, $4) ON CONFLICT (email) 
        DO UPDATE SET google_id = $1, fullname = $4 returning *`,
        [sub, given_name, email, name]
      );

      const results = await pool.query("select * from users where email = $1", [
        email,
      ]);
      const { user_id, username, fullname, roles } = results.rows[0];
      const token = jwt.sign({ id: user_id, roles: roles }, process.env.SECRET);

      res.header("auth-token", token);
      res.status(200).json({
        token,
        user_id,
        email,
        username,
        fullname,
        roles,
        status: "Login successful 🔓",
      });
    } catch (error) {
      console.log(error)
      res.status(500).send(error);
    }
  } catch (error) {
    console.log(error);
    res.status(401).json({msg: "ID token required"});
  }
}

const forgotPassword = async (req, res) => {
  const { email } = req.body;
  const {rows: dbEmail} = await pool.query(
    "SELECT EXISTS (SELECT * from users where email = $1)",
    [email]
  );

  if (dbEmail[0].exists) {
    try {
      await pool.query(
        `update public."resetTokens" set used = $1 where email = $2`,
        [true, email]
      );

      //Create a random reset token
      var fpSalt = crypto.randomBytes(64).toString("base64");

      //token expires after one hour
      var expireDate = moment().add(1, "h").format();

      try {
        await pool.query(
          `insert into public."resetTokens" (email, expiration, token) values ($1, $2, $3)`,
          [email, expireDate, fpSalt]
        );

        mail
          .forgotPasswordMail(fpSalt, email)
          .then(() => {
            return res.json({ status: "OK" });
          })
          .catch((err) => console.log(err));
      } catch (error) {
        console.log(error);
        res.status(500).send(error);
      }
    } catch (error) {
      console.log(error);
      res.status(500).send(error);
    }
  } else {
    res.status(500).send("Email not found!");
  }
}

// verify password reset token
const verifyResetToken = async (req, res) => {
  const { token, email } = req.body;
  try {
    await pool.query(
      `delete from public."resetTokens" where expiration <= $1`,
      [curDate]
    );

    try {
      const result = await pool.query(
        `
        select * from public."resetTokens" 
        where token = $1 AND email = $2 AND expiration > $3 AND used = $4
      `,
        [token, email, curDate, false]
      );

      if (result.rowCount < 1) {
        res.json({
          message: "Token has expired. Please try password reset again.",
          showForm: false,
        });
      } else {
        res.json({
          result: result.rows[0],
          showForm: true,
        });
      }
    } catch (error) {
      console.log(error);
      res.json("Unknown error", error);
    }
  } catch (error) {
    console.log(error);
  }
}

const resetPassword = async (req, res) => {
  const { password, password2, token, email } = req.body;

  const isValidPassword =
    typeof password == "string" && password.trim().length >= 6;

  if (password !== password2)
    return res.json({ message: "Password do not match.", status: "error" });

  if (!isValidPassword)
    return res.json({
      status: "error",
      message: "Password length must be at least 6 characters",
    });

  try {
    const result = await pool.query(
      `
        select * from public."resetTokens" 
        where token = $1 AND email = $2 AND expiration > $3 AND used = $4
      `,
      [token, email, curDate, false]
    );

    if (result.rowCount < 1)
      return res.json({
        status: "error",
        message:
          "Token not found. Please try the reset password process again.",
      });

    try {
      await pool.query(
        `update public."resetTokens" set used = $1 where email = $2`,
        [true, email]
      );

      const hashedPassword = hashPassword(password)

      try {
        await pool.query(`update users set password = $1 where email = $2`, [
          hashedPassword,
          email,
        ]);
        mail.resetPasswordMail(email).then(() =>
          res.json({
            status: "OK",
            message: "Password reset. Please login with your new password.",
          })
        );
      } catch (error) {
        console.log(error);
        res.json(error);
      }
    } catch (error) {
      console.log(error);
      res.json(error);
    }
  } catch (error) {
    console.log(error);
    res.json(error);
  }
}

module.exports = {
  createAccount,
  loginUser,
  googleLogin,
  forgotPassword,
  verifyResetToken,
  resetPassword
}