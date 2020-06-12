#!/usr/bin/env node

const { program } = require("commander");
const newman = require("newman");
const yaml = require("js-yaml");
var fs = require("fs");
var path = require("path");
var util = require("util");
const exec = util.promisify(require("child_process").exec);
const request = util.promisify(require("request"));
const sleep = require("util").promisify(setTimeout);

async function execute() {
  program
    .option("-d, --docker", "Mongo in docker container")
    .option("-m, --mongo <mongo>", "Mongo location")
    .option("-f, --file <file>", "Configuration file")
    .option("-s, --serverurl <serverurl>", "Server URL")
    .option("-i, --ip <ip>", "Postman IP Keyword")
    .option("-j, --jenkins", "Triggered by jenkins")
    .option("-p, --port <port>", "Postman Port keyword");

  program.parse(process.argv);
  console.info(program.opts());

  let confFile = "";
  if (program.file) {
    confFile = program.file;
  } else {
    confFile = "postman-executor.yaml";
  }

  let ipKeyword = "ip";
  if (program.ip) {
    ipKeyword = program.ip;
  }
  let portKeyword = "puerto";
  if (program.port) {
    portKeyword = program.port;
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

  //Check global seed files
  //If it has global confs.
  if (confData.global !== undefined) {
    //If it has a global database
    if (confData.global.database !== undefined) {
      globalDatabase = confData.global.database;
      databases.push(globalDatabase);
    }

    //If it has a data array
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

    test.postmancollection = filePath;
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
    test.name = keys[0];
    test.data = datas;
    tests.push(test);
  }

  //Check the mongo Conf
  let mongoIP = "localhost";
  if (program.mongo) {
    let str = program.mongo.split(":");
    if (str.length !== 2) {
      console.error("--mongo has an incorrect format, it should be: ip:port");
      return;
    }
    mongoIP = str[0];
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
  let found = false;
  var conter = new Array(10);
  //If it was configured from jenkins it will try 10 times every 10 secs
  for (var i of conter) {
    try {
      await request(serverUrl);
      console.info("Server at " + serverUrl + " found");
      found = true;
      break;
    } catch (error) {
      if (!program.jenkins) {
        console.error(
          "Error: " + "The server at " + serverUrl + " was not found"
        );
        return;
      } else {
        await sleep(4000);
      }
    }
  }
  if (!found) {
    console.error("Error: " + "The server at " + serverUrl + " was not found!");
    return;
  }
  console.info("Found " + tests.length + " Tests.");

  console.info("Starting integration-tests");
  //For each postman test.
  for (test of tests) {
    console.info(test.name + ":");

    //Delete all collections.
    if (program.docker) {
      await exec(
        "docker exec " +
          mongoIP +
          " mongo " +
          data.database +
          ' --eval "db.getCollectionNames().forEach(function(n){db[n].remove({})});"'
      );
    } else {
      await exec(
        "mongo " +
          data.database +
          ' --eval "db.getCollectionNames().forEach(function(n){db[n].remove({})});"'
      );
    }

    //Seed the global data.
    for (data of globalData) {
      if (data.strategy === "Always") {
        await seed(program.docker, data, mongoIP);
      }
    }
    //Seed the specific data
    for (data of test.data) {
      await seed(program.docker, data, mongoIP);
    }
    console.info("Done Seeding");
    //Run newman tests.
    let options = {
      collection: require(test.postmancollection),
      reporters: ["cli", "junit"],
      environment: {
        name: "Postman-Executor-Env",
        values: [
          {
            key: ipKeyword,
            value: serverIP,
            type: "text",
            enabled: true,
          },
          {
            key: portKeyword,
            value: serverPort,
            type: "text",
            enabled: true,
          },
        ],
      },
      reporter: {
        junit: {
          export: path.join(
            path.format({ dir: confDir }),
            "/postman-executor-results/" + test.name + "Results.xml"
          ),
        },
      },
    };
    console.info("Starting newman.....");
    newman.run(options, function (err) {
      if (err) {
        throw err;
      }
      console.log("collection run complete!");
    });
  }

  //END
}

execute();

async function seed(docker, data, mongoIP) {
  if (docker) {
    await exec("docker cp " + data.file + " " + mongoIP + ":seed.json");
    await exec(
      "docker exec " +
        mongoIP +
        " mongoimport --db=" +
        data.database +
        " --collection=" +
        data.collection +
        " --file=seed.json --jsonArray"
    );
  } else {
    await exec(
      "mongoimport --db=" +
        data.database +
        " --collection=" +
        data.collection +
        " --file=" +
        data.file +
        " --jsonArray"
    );
  }
}

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

  let filePath, contents;
  try {
    filePath = path.join(path.format({ dir: confDir }), obj.file.toString());
  } catch (error) {
    console.error(
      "The data object " +
        keys[0] +
        ".file " +
        obj.file +
        " is invalid. Specify a valid path"
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
  obj.file = filePath;
  obj.name = keys[0];
  return obj;
}
