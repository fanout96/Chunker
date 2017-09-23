var m3u8Parser = require('m3u8-parser');
var uuid = require("uuid");
var path = require('path');
var get = require('simple-get');
var fs = new require('fs');
var ffmpeg = require('fluent-ffmpeg');
var command = ffmpeg();

var uuidpath = path.resolve(__dirname, uuid.v4());
if (!fs.existsSync(uuidpath)) {
    fs.mkdirSync(uuidpath);
}

var source = process.argv[2];

var modelname = source.split('-')[1].split('/')[1].replace('amlst:', '');
var chunklist = [];

var dateTime = require('node-datetime').create().format('Y_m_d_H_M_S_');
var filename = dateTime + modelname + ".ts";
var resultfile = path.resolve(__dirname, filename);

var chunklisturl = "";

var timerId;
var shutdown = false;

GetPlayList();

function GetPlayList() {
    get.concat(source, function(err, res, data) {
        if (!err) {
            res.body = Buffer(data).toString();

            var Streaming = (!(res.statusCode == 404) && !(res.statusCode == 403) && (res.statusCode == 200 && (res.body.indexOf("#EXT-X-STREAM-INF") > -1)));
            var Recording = (Object.keys(chunklist).length > 0);

            if (!Streaming && Recording) {
                console.log("Стрим закончен");
                timerId = setTimeout(GetChunkList, 60 * 60 * 1000);
                ConcatChunks(); /*Стрим закончен Обработать данные*/
            } else if (!Streaming && !Recording) {
                console.log("Стрим не найден");
                process.exit(0); /*Стрим не найден обновите плейлист*/
            } else {
                console.log("Стрим найден");

                var Resolutions = getResolutions(res.body);
                var ResKeys = Object.keys(Resolutions);
                console.log("Доступные разрешения: ", Object.keys(Resolutions));

                var low = ResKeys.slice(0).shift();
                console.log("Минимальное разрешение: ", low);

                var srres = ResKeys[ResKeys.length / 2];
                console.log("Среднее разрешение: ", srres);

                var high = ResKeys.slice(-1).pop();
                console.log("Максимальное разрешение: ", high);

                chunklisturl = source.substring(0, source.length - 13) + Resolutions[high];

                GetChunkList();
            }

        } else {
            throw err;
        }

    });
}

function GetChunkList() {
    get.concat(chunklisturl, function(err, res, data) {
        if (!err) {
            res.body = Buffer(data).toString();

            var Streaming = (!(res.statusCode == 404) && !(res.statusCode == 403) && (res.statusCode == 200 && (res.body.indexOf("#EXTINF:") > -1)));
            var Recording = (Object.keys(chunklist).length > 0);


            if (!Streaming && Recording) {
                console.log("Стрим закончен");
                timerId = setTimeout(GetChunkList, 60 * 60 * 1000);
                ConcatChunks(); /*Стрим закончен Обработать данные*/
            } else if (!Streaming && !Recording) {
                console.log("Чанки не найдены");
                process.exit(0); /*Стрим не найден обновите плейлист*/
            } else if (!shutdown) {
                timerId = setTimeout(GetChunkList, 500);
                var ch = getChunks(res.body);
                console.log("Чанки найдены: " + ch);
                ch.forEach(function(entry) {

                    var chunkid = entry.toString().split('_').pop();

                    if (!chunklist.hasOwnProperty(chunkid)) {

                        console.log("Загрузка чанка: ", chunkid, ":", entry);
                        var file = path.resolve(uuidpath, chunkid);
                        chunklist[chunkid] = true;
                        try {
                            get(source.substring(0, source.length - 13) + entry, function(err2, res2) {
                                if (err2) {
                                    console.log(err2);
                                    console.log("Ошибка загрузки чанка: ", chunkid);
                                    chunklist[chunkid] = false;
                                }

                                var stream = res2.pipe(fs.createWriteStream(file)) // `res` is a stream
                                stream.on('finish', function() {
                                    console.log("Загружен чанк: ", chunkid);
                                });
                                stream.on('error', function() {
                                    console.log("Ошибка загрузки чанка: ", chunkid);
                                    chunklist[chunkid] = false;
                                });
                            });
                        } catch (err) {}
                    }
                });
            }

        } else {
            throw err;
        }

    });
}

function getChunks(res) {
    var parser = new m3u8Parser.Parser();
    parser.push(res);
    parser.end();

    var chunks = [];

    parser.manifest.segments.forEach(function(entry) {
        chunks.push(entry.uri);
    });

    return chunks;
}

function getResolutions(res) {
    var parser = new m3u8Parser.Parser();
    parser.push(res);
    parser.end();

    var resolutions = [];

    parser.manifest.playlists.forEach(function(entry) {
        resolutions[entry.attributes.RESOLUTION.height] = entry.uri;
    });

    return resolutions;
}

function ConcatChunks() {
    timerId = setTimeout(GetChunkList, 60 * 60 * 1000);
    shutdown = true;

    fs.readdir(uuidpath, function(err, items) {

        var chunkslist = items.map(function(item) {
            return "file '" + path.resolve(uuidpath, item) + "'";
        })
        var chunks = items.map(function(item) {
            return path.resolve(uuidpath, item);
        })

        var file = fs.createWriteStream(path.resolve(uuidpath, "list.txt"));
        file.on('error', function(err) {});
        chunkslist.forEach(function(i) {
            file.write(i + '\n');
        });
        file.end();

        var cmd = ffmpeg()
            .on('start', function(cmdline) {
                console.log('Start concat chunks');
            })
            .on('progress', function(progress) {
                console.info("Processing : " + progress.percent + " % done");
            })
            .on('error', function(err, stdout, stderr) {
                console.log('Cannot process video: ' + err.message);
            })
            .on('end', function(stdout, stderr) {
                console.log('Transcoding succeeded !');
                chunks.forEach(function(i) {
                    fs.unlinkSync(i);
                });
                fs.unlinkSync(path.resolve(uuidpath, "list.txt"));
                fs.rmdirSync(uuidpath);
                process.exit(0);
            })
            .input(path.resolve(uuidpath, "list.txt"))
            .inputOptions(['-f concat', '-safe 0'])
            .output(resultfile)
            .videoCodec('copy')
            .audioCodec('copy')
            .run();
    });
}

process.on('SIGINT', function() {
    ConcatChunks();
});