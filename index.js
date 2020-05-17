"use strict";

const { program } = require("commander");
const newman = require("newman");
const yaml = require("js-yaml");
var fs = require("fs");
var path = require("path");
var util = require("util");
const exec = util.promisify(require("child_process").exec);
const request = util.promisify(require("request"));

async function execute() {
  program
    .option("-d, --docker", "Mongo in docker container")
    .option("-m, --mongo <mongo>", "Mongo location")
    .option("-f, --file <file>", "Configuration file")
    .option("-s, --serverurl <serverurl>", "Server URL");

  program.parse(process.argv);
  console.info(program.opts());

  let confFile = "";
  if (program.file) {
    confFile = program.file;
  } else {
    confFile = "postman-executor.yaml";
  }

  //Check if the file exists.
  var filename, contents;
  try {
    filename = path.join(process.cwd(), confFile);
    contents = fs.readFileSync(filename, "utf8");
  } catch (error) {
    console.error("The file " + filename + " was not found.");
    return;
  }

  let confDir = path.parse(filename).dir;
  var confData = {};
  try {
    confData = yaml.load(contents);
  } catch (error) {
    console.error("Cannot load the configuration file correctly");
    return;
  }
  var globalDatabase = null;
  var globalData = [];
  var databases = [];
  var tests = [];

  //Se verifican los datos del archivo.
  //Si el archivo tiene confs globales
  if (confData.global !== undefined) {
    //Si tiene base de datos global
    if (confData.global.database !== undefined) {
      globalDatabase = confData.global.database;
      databases.push(globalDatabase);
    }
    //Si tiene data y es un arreglo
    if (
      confData.global.data !== undefined &&
      Array.isArray(confData.global.data)
    ) {
      for (var data of confData.global.data) {
        let val = await checkdata(data, globalDatabase, confDir);
        if (val instanceof Error) return;
        globalData.push(val);
      }
    } else if (confData.global.data !== undefined) {
      console.error("Global.Data should be a list of data objects, use '-'");
      return;
    }
  }

  if (
    confData["integration-tests"] === undefined ||
    !Array.isArray(
      confData["integration-tests"] ||
        confData["integration-tests"].length === 0
    )
  ) {
    console.error(
      "integration-tests should be a list of test objects, use '-'"
    );
    return;
  }

  //Check the Integration-tests Data
  for (var test of confData["integration-tests"]) {
    let keys = Object.keys(test);
    if (keys.length !== 1) {
      console.error("All integration-tests objects should have a single key.");
      return;
    }
    let obj = test[keys[0]];
    let datas = [];
    test = {};
    if (obj.postmancollection === undefined) {
      console.error(
        "The integration-test object " +
          keys[0] +
          " does not have a postmancollection. Specify a " +
          keys[0] +
          ".postmancollection value."
      );
      return;
    }

    let filePath;
    try {
      filePath = path.join(
        path.format({ dir: confDir }),
        obj.postmancollection.toString()
      );
    } catch (error) {
      console.error(
        "The integration-test object " +
          keys[0] +
          ".postmancollection " +
          obj.file +
          " is invalid. Specify a valid path"
      );
      return;
    }

    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      console.error(
        "The integration-test object " +
          keys[0] +
          ".postmancollection " +
          filePath +
          " was not found."
      );
      return;
    }

    test.postmancollection = obj.postmancollection;
    if (
      obj.data !== undefined &&
      Array.isArray(obj.data) &&
      obj.data.length > 0
    ) {
      for (var data of obj.data) {
        let val = await checkdata(data, globalDatabase, confDir);
        if (val instanceof Error) return;
        if (databases.indexOf(val.database) === -1) {
          databases.push(val.database);
        }
        datas.push(val);
      }
    }
    test.data = datas;
    tests.push(test);
  }

  //Check the mongo Conf
  let mongoIP = "localhost",
    mongoPort = "27017";
  if (program.mongo) {
    let str = program.mongo.split(":");
    if (str.length !== 2) {
      console.error("--mongo has an incorrect format, it should be: ip:port");
      return;
    }
    mongoIP = str[0];
    mongoPort = str[1];
  }
  if (program.docker) {
    try {
      await exec(
        "docker exec " +
          mongoIP +
          ' mongo --eval "printjson(db.serverStatus())"'
      );
      console.info(
        "MongoDB docker container " +
          mongoIP +
          " was found and is working correctly!"
      );
    } catch (err) {}
  } else {
    try {
      await exec('mongo --eval "printjson(db.serverStatus())"');
      console.info("Mongo local was found and is working correctly!");
    } catch (err) {
      if (toString(err).includes("'mongo' is not recognized")) {
        console.error("Mongo was not found.");
      } else {
        console.error("Mongo is not ready.");
      }
      return;
    }
  }

  //Check the serverConf
  let serverUrl = "http://localhost:3001";
  if (program.serverurl) {
    serverUrl = program.serverurl;
  }
  var serverIP, serverPort;
  let str = serverUrl.split("//");
  let tempIpPort = str[0];
  if (str.length > 0) {
    tempIpPort = str[1];
  }
  let str2 = tempIpPort.split(":");
  if (str2.length !== 2) {
    console.error(
      "--serverurl has an incorrect format, it should be: http(s)://ip:port or ip:port "
    );
    return;
  }
  serverIP = str2[0];
  serverPort = str2[1];
  try {
    await request(serverUrl);
    console.info("Server at " + serverUrl + " found");
  } catch (error) {
    console.error("Error: " + "The server at " + serverUrl + " was not found");
    return;
  }
  console.log(databases);
  console.log(tests);
}

execute();

//Verifies that the dataobject is valid.
function checkdata(data, globalDatabase, confDir) {
  let keys = Object.keys(data);
  if (keys.length !== 1) {
    console.error(
      "The data object " +
        keys[0] +
        " has more than one key, all data objects should have a single key."
    );
    return new Error();
  }
  let obj = data[keys[0]];
  if (obj.collection === undefined) {
    console.error(
      "The data object " +
        keys[0] +
        " does not have a collection. Specify a " +
        keys[0] +
        ".collection value."
    );
    return new Error();
  }
  if (obj.database === undefined) {
    if (globalDatabase === null) {
      console.error(
        "The data object " +
          keys[0] +
          " does not have a database. Specify a global.database value or a " +
          keys[0] +
          ".database value."
      );
      return new Error();
    } else {
      obj.database = globalDatabase;
    }
  }
  if (obj.file === undefined) {
    console.error(
      "The data object " +
        keys[0] +
        " does not have a file. Specify a " +
        keys[0] +
        ".file value."
    );
    return new Error();
  }
  if (obj.file.toString() !== "[object Object]") {
    let filePath, contents;
    try {
      filePath = path.join(path.format({ dir: confDir }), obj.file.toString());
    } catch (error) {
      console.error(
        "The data object " +
          keys[0] +
          ".file " +
          obj.file +
          " is invalid. Specify a valid path or an empty object {}"
      );
      return new Error();
    }
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      console.error(
        "The data object " + keys[0] + ".file " + filePath + " was not found."
      );
      return new Error();
    }
  } else {
    if (Object.keys(obj.file).length > 0) {
      console.error(
        "The data object " +
          keys[0] +
          ".file " +
          obj.file +
          " is invalid. Specify a valid path or an empty object {}"
      );

      return new Error();
    }
  }
  return obj;
}
