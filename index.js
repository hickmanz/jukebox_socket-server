
const express = require('express')
const app = express()
var http = require('http').Server(app);
var config = require('config');
var querystring = require('querystring');
var io = require('socket.io')(http);
const path = require('path')
var SpotifyWebApi = require('spotify-web-api-node');
const Datastore = require('nedb');
const db = new Datastore({ filename: path.join('./', 'main.db'), autoload: true, timestampData: true  });

var currentQueue = []
var historyQueue = []

app.use('/', express.static('public'))

var client_id
var client_secret
var redirect_uri

var auth_scope = 'streaming user-read-birthdate user-read-recently-played user-read-email user-read-private user-read-playback-state user-modify-playback-state'
var access_token;
var refresh_token;

var spotifyApi

var playerTimer

var player = {
    volume: 0.5,
    state: "paused",
    duration: 0,
    position: 0,
    timeLeft: 50000,
    lastUpdate: 0,
    currentPlaying: null,
    playback: null
}

var tokenData = {
    _id : 'tokenData',
    access_token: access_token,
    refresh_token: refresh_token,
    spotifyTokenExpirationEpoch: ''
}

async function getMetadata() {
        client_id = config.get('spotify.client_id')
        console.log(client_id)
        client_secret = config.get('spotify.client_secret')
        redirect_uri = config.get('spotify.redirect_uri')
        setupPlayer()
}

async function setupPlayer() {
   
    spotifyApi = new SpotifyWebApi({
        clientId : client_id,
        clientSecret : client_secret,
        redirectUri : redirect_uri,
        scope: auth_scope
    });

    db.findOne({_id: 'tokenData'}, function(err, doc){
        if (doc==null){
            db.insert(tokenData, function (err, newDoc) {   
            });
        } else {
            tokenData.access_token = doc.access_token
            tokenData.refresh_token = doc.refresh_token
            tokenData.spotifyTokenExpirationEpoch = doc.spotifyTokenExpirationEpoch
            spotifyApi.setAccessToken(tokenData.access_token);
            spotifyApi.setRefreshToken(tokenData.refresh_token);
            checkToken()
        }
    })
    db.findOne({_id: 'playerData'}, function(err, doc){
        if (doc==null){
            db.insert(player, function (err, newDoc) {   
            });
        } else {
            player.volume = doc.volume
    
        }
    })

}

getMetadata()

app.get('/login', function(req, res) {
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
        response_type: 'code',
        client_id: client_id,
        scope: auth_scope,
        redirect_uri: redirect_uri
    }));
});


app.get('/callback', function(req, res) {
    var code = req.query.code || null;

    authCodeGrant(code)
    res.redirect('/')

  });





function clientCodeGrant(){
    // Retrieve an access token
    spotifyApi.clientCredentialsGrant()
    .then(function(data) {
        console.log('The access token expires in ' + data.body['expires_in']);
        console.log('The access token is ' + data.body['access_token']);

        // Save the access token so that it's used in future calls
        spotifyApi.setAccessToken(data.body['access_token']);
    }, function(err) {
        console.log('Something went wrong when retrieving an access token', err.message);
    });
}

function authCodeGrant(authorizationCode){

    spotifyApi.authorizationCodeGrant(authorizationCode)
    .then(function(data) {

        // Set the access token and refresh token
        spotifyApi.setAccessToken(data.body['access_token']);
        spotifyApi.setRefreshToken(data.body['refresh_token']);

        // Save the amount of seconds until the access token expired
        tokenData.spotifyTokenExpirationEpoch = (new Date().getTime() / 1000) + data.body['expires_in'];

        tokenData.access_token = data.body['access_token']
        tokenData.refresh_token = data.body['refresh_token']

        db.update({_id: 'tokenData'}, tokenData, {}, function(){
        })

        console.log('Retrieved token. It expires in ' + Math.floor(tokenData.spotifyTokenExpirationEpoch - new Date().getTime() / 1000) + ' seconds!');
    }, function(err) {
        console.log('Something went wrong when retrieving the access token!', err.message);
    });

}


function checkToken(){
    return new Promise(function (fulfill, reject){
        var timeToExp = Math.floor(tokenData.spotifyTokenExpirationEpoch - new Date().getTime() / 1000)
        console.log(timeToExp)
        if ( timeToExp < 500){
            spotifyApi.refreshAccessToken().then(function(data) {
                tokenData.spotifyTokenExpirationEpoch = (new Date().getTime() / 1000) + data.body['expires_in'];
                console.log('Refreshed token. It now expires in ' + Math.floor(tokenData.spotifyTokenExpirationEpoch - new Date().getTime() / 1000) + ' seconds!');
                tokenData.access_token = data.body['access_token']
                spotifyApi.setAccessToken(tokenData.access_token);
                db.update({_id: 'tokenData'}, tokenData, {}, function(){
                })
                io.local.emit('updateTokenData', tokenData)
                fulfill(true);
            }, function(err) {
                console.log('Could not refresh the token!', err.message);
                fulfill(false);
            });
        } else {
            fulfill(false);
        }
    })
}

io.on('connection', function(socket){
    console.log('a user connected');
    socket.emit('update-player', player)
    socket.emit('updateQueue', currentQueue);
    socket.emit('test', 'come one buddy')
    socket.emit('updateTokenData', tokenData)
    socket.on('player-get-token', function(data, fn){
        checkToken().then(function(){
            fn(tokenData)
        })
    })
    socket.on('get-recently-played', function(){
        spotifyApi.getMyRecentlyPlayedTracks({limit: 50}).then(data => {
            console.dir(data);
            socket.emit('recently-played', data)
        }, err =>{
            console.error(err);
        });
    })
    socket.on('player-update', function(data){
        //calc and let everyone know whats up
    })
    socket.on('shuffle-playlist', function(){
        shuffle(currentQueue);
    })
    socket.on('player-ready', function(data){
        setPlayerVolume(socket)
        player.device_id = [data]
        console.log('in here gettin ready')
        console.log(socket.id)
        player.socket = socket.id
        console.dir(player)
        console.log('player-ready')
        checkToken().then(function(resp){
            spotifyApi.transferMyPlayback({ deviceIds: player.device_id, play: true}).then(state => {
                console.dir(state);
            }, err =>{
                console.error(err);
            });
        })

    })
    socket.on('restart-player', function(){
        if (io.sockets.connected[player.socket]) {
            io.sockets.connected[player.socket].emit('restart')
        }
    })
    socket.on('token_expired', function(){
        checkToken().then(function(){
            fn(tokenData)
        })
    })
    socket.on('search', function(data){
        console.log('req from: ' + socket.id)
        console.log('search term: ' + data);

        checkToken().then(function(resp){
            spotifyApi.searchArtists(data)
                .then(function(response) {
                    socket.emit('artistSrchResp', response);
                }, function(err) {
                    console.error(err);
                });
            spotifyApi.searchAlbums(data)
                .then(function(response2) {
                    socket.emit('albumSrchResp', response2);
                }, function(err) {
                    console.error(err);
                });
            spotifyApi.searchTracks(data, {limit: 50})
                .then(function(response3) {
                    socket.emit('trackSrchResp', response3);
                }, function(err) {
                    console.error(err);
                });  
        })

    });
    socket.on('preview', function(data){
        console.log('req from: ' + socket.id)
        console.log('preview: ' + data.data);
        checkToken().then(function(){

            spotifyApi.getTracks([data.data]).then(function(trackData) {
                socket.emit('previewData', trackData)
            }, function(err) {
                console.error(err);
            });     
        })   
        

    })
    socket.on('editQueue', function(req){
        if(req.type == "addSong"){
            req.data.guid = guid()
            if(req.data.length > 1){
                req.data.forEach(function(track){
                    if(track.is_local){
                        //dont add. alert
                    } else {
                        currentQueue.push(track)
                    }
                })
                
            }else {
                if(req.data.is_local){
                    //dont add local songs 
                    //alert people
                } else {
                    currentQueue.push(req.data);
                }
            }
            

            console.log('add song')
            if (player.currentPlaying == null ){
                playNextSong()
            } else if (player.state == "paused" && currentQueue.length == 1) {
                console.log('this one')
                playNextSong()
            } else {
                sendQueue();
            }
        } else if(req.type == "removeSong") {
            //remove by id
            var rmIndex = findIndexInData(currentQueue, 'guid', req.data)
            currentQueue.splice(rmIndex, 1)
            sendQueue()

        } else if(req.type == "moveSong"){
            moveSong(req);
        } else if (req.type == "nukeIt"){
            currentQueue = []
            player.currentPlaying = null
            if(player.state == "playing"){
                if (io.sockets.connected[player.socket]) {
                    io.sockets.connected[player.socket].emit('toggle-play')
                }
            }
            sendQueue()
        }
    });
    socket.on('player_state_changed', function(data){
        if(data !== null){
            player.playback = data
            player.position = data.position
            player.lastUpdate = 0
            updatePlayerTime() 
            if(data.paused == true){
                if(player.timeLeft < 2000){
                    playNextSong()
                }
                player.state = 'paused'
            } else {
                player.state = 'playing'
            }
            //update timer - send new data to clients
            io.emit('update-player', player)
        }
    }) 
    socket.on('next-song', function(data){
        playNextSong()
    })
    socket.on('previous-song', function(){
        nextSong = historyQueue.shift()
        player.currentPlaying = nextSong
        player.duration = nextSong.duration_ms
        playSong(nextSong.uri)
    })
    socket.on('play', function(){
        if (player.state == "paused"){
            if (io.sockets.connected[player.socket]) {
                io.sockets.connected[player.socket].emit('toggle-play')
            }
        }
    })
    socket.on('pause', function(){
        if(player.state == "playing"){
            if (io.sockets.connected[player.socket]) {
                io.sockets.connected[player.socket].emit('toggle-play')
            }
        }
    })
    socket.on('scrub', function(data){
        console.log('SEEEEKING')
        console.log(player.socket)
        //if (io.sockets.connected[player.socket]) {
            socket.broadcast.emit('seek', data)
        //}
    })
    function shuffle(array) {
        var currentIndex = array.length
        , temporaryValue
        , randomIndex
        ;

        // While there remain elements to shuffle...
        while (0 !== currentIndex) {

            // Pick a remaining element...
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex -= 1;

            // And swap it with the current element.
            temporaryValue = array[currentIndex];
            array[currentIndex] = array[randomIndex];
            array[randomIndex] = temporaryValue;
        }

        currentQueue = array
        sendQueue()
    }

    function updatePlayerTime(){
        clearInterval(playerTimer)
        if(player.duration !== 0 ){

            if (player.state == "playing"){
                playerTimer = setInterval(function(){   
                    player.position += 500
                    player.timeLeft = player.duration - player.position
                    player.lastUpdate += 500
                    if(player.lastUpdate > 15000){
                        player.lastUpdate = 0
                        if (io.sockets.connected[player.socket]) {
                            io.sockets.connected[player.socket].emit('time-check')
                        }
                    }
                    if(player.duration - player.position < 1500){
                        playNextSong()
                    }
                }, 500);
            }   
        }  
    }
    function playNextSong(){
        historyQueue.unshift(player.currentPlaying)
        if(historyQueue.length > 20){
            historyQueue.pop()
        } 
        player.timeLeft = 500000
        if (currentQueue.length > 0){
            nextSong = currentQueue.shift()
            player.currentPlaying = nextSong
            player.duration = nextSong.duration_ms
            sendQueue()
            playSong(nextSong.uri)
        }
    }
    function playSong(uri){
        console.log(uri)
        checkToken().then(function(wasUpdated){
            spotifyApi.play({device_id: player.device_id, uris: [uri]}).then(resp => {
                console.dir(resp);
            }, err =>{
                console.error(err);
            });
        })
    }
    function sendQueue(){
        io.emit('updateQueue', currentQueue);
    }

    function moveSong(req){
        var currentIndex = currentQueue.findIndex(x => x.id == req.data.trackId);
        var offset = req.data.oldIndex - currentIndex;
        var setIndex = req.data.newIndex - offset;

        if (setIndex >= currentQueue.length) {
            var k = setIndex - currentQueue.length;
            while ((k--) + 1) {
                currentQueue.push(undefined);
            }
        }
        currentQueue.splice(setIndex, 0, currentQueue.splice(currentIndex, 1)[0]);

        sendQueue();
    }
    function setPlayerVolume(socket){
        socket.emit('set-volume', player.volume)

    }

});
function guid() {
    function s4() {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}
function findIndexInData(data, property, value) {
    for(var i = 0, l = data.length ; i < l ; i++) {
      if(data[i][property] === value) {
        return i;
      }
    }
    return -1;
  }
http.listen(8080, function () {
  console.log('Example app listening on port 8080!')
})