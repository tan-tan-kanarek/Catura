/**
 * Created by itayk on 22/06/2017.
 */
let map;
let currentMarker;
let socket = null;
let localVideo = null;
let localStream = null;
let peerConnection = null;
let usePlanB = false;
let isRecording = false;
let recordingStartTime = null;
let userId = null;


styles = [
    {
        featureType : 'poi.business',
        stylers : [ {
            visibility : 'off'
        } ]
    },
    {
        featureType : 'transit',
        elementType : 'labels.icon',
        stylers : [ {
            visibility : 'off'
        } ]
    }
];

function init() {
    updateHeight();
    
    localVideo = document.getElementById('localVideo');

    if (window.window.webkitRTCPeerConnection) {
        usePlanB = true;
    }

    navigator.getUserMedia	= navigator.getUserMedia
        || navigator.webkitGetUserMedia
        || navigator.mozGetUserMedia
        || navigator.msGetUserMedia;

    RTCPeerConnection = window.RTCPeerConnection
        || window.webkitRTCPeerConnection
        || window.mozRTCPeerConnection;

    RTCSessionDescription = window.RTCSessionDescription
        || window.webkitRTCSessionDescription
        || window.mozRTCSessionDescription;

    let location = {
        lat : 32.0878708,
        lng : 34.7872071
    };

    let zoom = 13;

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((position) => {
            location = {
                lat : position.coords.latitude,
                lng : position.coords.longitude
            };
        zoom = 15;
        initMap(location, zoom);
    });
    }
    else {
        initMap(location, zoom);
    }

    initSocketIo();
    checkUser();
}

function checkUser(){
    if (readCookie('userId')){
    	userId = readCookie('userId')
    	if(userId) {
    	    getUser(userId);
    	}
    }
    else {
    	userId = Math.ceil(Math.random()*10000000000000000);
    	createCookie('userId', userId);
    	addUser(userId);
    }
}

function updateUserUI(){
    $("#loginBtn").hide();
    $("#signupBtn").hide();
    $("#userDetail").hide();

    //user is connected:
    $("#userDetail").show();
}


function initSocketIo() {
    socket = io();

    socket.on('error', function(err){
        console.error('Socket.io error:', err);
    });

    socket.on('room-created', function(room){
        console.log('Receive [room-created]: ', room);
        joinRoom(room.id);
    });

    socket.on('offer', function(sdp){
        console.log('Receive [offer]: ', sdp);
        let offer = new RTCSessionDescription({
            type: 'offer',
            sdp: sdp
        });
        setOffer(offer);
    });

    socket.on('answer', function(sdp){
        console.log('Receive [answer]: ', sdp);
        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: sdp
        });
        setAnswer(answer);
    });

    socket.on('recording', function(recordingId){
        console.log('Receive [recording]', recordingId);
        recording(recordingId);
    });

    socket.on('ready', function(){
        console.log('Receive [ready]');
    });

    socket.on('login', function(user){
        console.log('Receive [login]', user);
        // TODO
    });

    socket.on('get-me', function(user){
        console.log('Receive [get-me]', user);
        // TODO
    });

    socket.on('get-user', function(user){
        console.log('Receive [get-user]', user);
        if(!user.id) {
        	addUser(userId);
        }
        else if(user.id === userId) {
        	login(userId);
        	updateUserUI();
        }
        else {
        	showUserDetails(user);
        }
    });

    socket.on('message-sent', function(messageId){
        console.log('Receive [message-sent]', messageId);
        // TODO
    });

    socket.on('private-message-sent', function(messageId){
        console.log('Receive [private-message-sent]', messageId);
        // TODO
    });
}

function setAnswer(sessionDescription) {
    if (! peerConnection) {
        console.error('Peer connection doesn\'t exist');
        return;
    }
    peerConnection.setRemoteDescription(sessionDescription)
        .then(function() {
            console.log('Set remote description');
        }).catch(function(err) {
        console.error('Set remote description error: ', err);
    });
}

function setOffer(sessionDescription) {
    if (peerConnection) {
        console.log('Peer connection alreay exist, reuse it');
    }
    else {
        console.log('Create new Peer connection');
        peerConnection = prepareNewConnection();
    }
    peerConnection.setRemoteDescription(sessionDescription)
        .then(function() {
            console.log('Set remote description');
            makeAnswer();
        }).catch(function(err) {
        console.error('Set remote description error: ', err);
    });
}

function prepareNewConnection() {
    let pc_config = {'iceServers':[]};
    let peer = new RTCPeerConnection(pc_config);

    peer.onicecandidate = function (evt) {
        if (evt.candidate) {
            console.log(evt.candidate);
        } else {
            console.log('Empty ICE event');
        }
    };
    peer.onnegotiationneeded = function(evt) {
        console.log('Negotiation needed');
    };

    peer.onicecandidateerror = function (evt) {
        console.error('ICE candidate ERROR:', evt);
    };
    peer.onsignalingstatechange = function() {
        console.log('Signaling state changed: ' + peer.signalingState);
    };
    peer.onicegatheringstatechange = function() {
        console.log('ICE gathering state changed: ' + peer.iceGatheringState);
    };

    peer.onconnectionstatechange = function() {
        console.log('Connection state changed: ' + peer.connectionState);
    };

    if (localStream) {
        console.log('Adding local stream');
        peer.addStream(localStream);
    }
    else {
        throw 'No local stream found, continue anyway.';
    }
    return peer;
}


function makeAnswer() {
    console.log('Create remote session description' );
    if (! peerConnection) {
        console.error('Peer connection doesn\'t exist');
        return;
    }

    peerConnection.createAnswer()
        .then(function (sessionDescription) {
            console.log('Create answer');
            return peerConnection.setLocalDescription(sessionDescription);
        }).then(function() {
        let answer = peerConnection.localDescription;
        send('joined', answer);
    }).catch(function(err) {
        console.error(err);
    });
}

function joinRoom(roomId) {
    peerConnection = prepareNewConnection();
    peerConnection.createOffer({
        offerToReceiveAudio : 1,
        offerToReceiveVideo : 1
    })
        .then(function (sessionDescription) {
            console.log('Offer created');
            send('join', {
                planb: usePlanB,
                roomId: roomId,
                sdp: sessionDescription.sdp
            });
        })
        .catch(function(err) {
            console.error(err);
        });
}

/**
 * Only userId is mandatory
 */
function addUser(userId, email, password, title, description, image) {
	let user = {
		id: userId
	};

	if(email) {
		user.email = email;
	}
	if(password) {
		user.password = password;
	}
	if(title) {
		user.title = title;
	}
	if(description) {
		user.description = description;
	}
	if(image) {
		user.image = image;
	}
	send('add-user', user);
}

function loginWithId(userId) {
	send('login-with-id', userId);
}

/**
 * Callback is login
 */
function login(email, password) {
	send('login', email, password);
}

function submitUser(){
	// TODO add image
	let email = jQuery('#email').val();
	let password = jQuery('#password').val();
	let title = jQuery('#name').val();
	let description = jQuery('#userDetails').val();
	updateUser(email, password, title, description);
}
/**
 * No argument is mandatory
 */
function updateUser(email, password, title, description, image) {
	let user = {
	};

	if(email) {
		user.email = email;
	}
	if(password) {
		user.password = password;
	}
	if(title) {
		user.title = title;
	}
	if(description) {
		user.description = description;
	}
	if(image) {
		user.image = image;
	}
	send('update-user', user);
}

/**
 * Call it without userId in order to get current user
 * Callback are get-user or get-me.
 */
function getUser(userId) {
	send('get-user', userId);
}

/**
 * Only type, title and Lat, Lng are mandatory
 * Radius is required for messages to specific area
 * Callback is message-sent
 */
function sendMessage(type, title, description, lat, lng, radius, image) {
	let message = {};
	send('send-message', message);
}

/**
 * Image is not required
 * Callback is private-message-sent
 */
function sendPrivateMessage(toUserId, message, image) {
	let message = {};
	send('send-private-message', toUserId, message);
}

function send(type, data) {
    console.log('Sending [' + type + ']: ', data);
    socket.emit(type, data);
}

function record() {
    if(!isRecording) {
        isRecording = true;
        send('create-room', 'room-name');
    }
}

function enableRecording() {
    jQuery('#videoControls').show();
}

function recording(recordingId) {
    jQuery('#recordingId').val(recordingId);
    let d = new Date();
    recordingStartTime = d.getTime();
    setTimeout(function() {
        checkRecordingTimer();
    }, 1000);
}

function stop() {
    if(isRecording) {
        isRecording = false;
        recordingStartTime = null;
        jQuery('#videoControls').hide();
        dissconnect();
    }
}

function checkRecordingTimer() {
    if(recordingStartTime === null) {
        return;
    }

    let d = new Date();
    let timeLeft = 60 - parseInt((d.getTime() - recordingStartTime) / 1000);

    if(timeLeft <= 0) {
        stop();
    }
    else {
        jQuery('#timer').text(timeLeft);
        setTimeout(function() {
            checkRecordingTimer();
        }, 1000);
    }
}

function searchLocation(location) {
    jQuery(document).ready(() => {
        jQuery.ajax({
            url: 'https://maps.googleapis.com/maps/api/geocode/json?latlng=' + location.lat + ',' + location.lng + '&result_type=street_address&language=he&key=AIzaSyCHbHtSrlsei68ZDvmkDBuvtARDeytLe1Y',
            dataType: 'json',
            type: 'GET',
            success: (data) => {
            if(data.results && data.results.length) {
        var result = data.results[0];
        jQuery('#search').val(result.formatted_address);
        initSearch(result.geometry);
    }
else {
        initSearch();
    }
}
});
});
}

function initSearch(geometry) {
    var input = document.getElementById('search');
    var autocomplete = new google.maps.places.Autocomplete(input);
    autocomplete.bindTo('bounds', map);

    currentMarker = new google.maps.Marker({
        map: map,
        anchorPoint: new google.maps.Point(0, -29)
    })
    if(geometry) {
        map.setZoom(17);
        currentMarker.setPosition(geometry.location);
    }


    autocomplete.addListener('place_changed', function() {
        currentMarker.setVisible(false);
        var place = autocomplete.getPlace();
        if (!place.geometry) {
            return;
        }

        if (place.geometry.viewport) {
            map.fitBounds(place.geometry.viewport);
        } else {
            map.setCenter(place.geometry.location);
            map.setZoom(17);
        }
        currentMarker.setPosition(place.geometry.location);
        currentMarker.setVisible(true);
    });
}

function initMap(location, zoom) {
    map = new google.maps.Map(document.getElementById('map'), {
        center : location,
        zoom : zoom,
        mapTypeControl : false,
        height: 800
    });

    map.addListener('bounds_changed', () => {
        loadMarkers();
        hideLoader();
    });

    map.setOptions({
        styles : styles
    });

    //map.controls[google.maps.ControlPosition.TOP_CENTER].push(document.getElementById('legend'));

    searchLocation(location);
}

function loadMarkers() {
    var bounds = map.getBounds();
    jQuery.ajax({
            url: '/markers.json',
            dataType: 'json',
            type: 'POST',
            contentType : 'application/json',
            data: JSON.stringify(bounds),
            success: (markers) => {
            	addMarkers(markers);
            }
    });
}

function addMarkers(markers) {
    markers.forEach((markerData) => {
        addMarker(markerData);
});
}

function addMarker(markerData) {
    markerData.map = map;
    markerData.icon = '/images/cat.png';

    var marker = new google.maps.Marker(markerData);
    marker.addListener('click', () => {
        showMarker(markerData);
});
}

function showMarker(markerData) {
    console.log('entryId:', markerData.entryId);
    if(markerData.entryId) {
        jQuery('#kaltura_player_1497188473').show();
        kWidget.embed({
            'targetId': 'kaltura_player_1497188473',
            'wid': '_1676801',
            'uiconf_id': 39738641,
            'flashvars': {
                'autoPlay': true
            },
            //'cache_st': 1497188473,
            'entry_id': markerData.entryId
        });
    }
    else {
        jQuery('#kaltura_player_1497188473').hide();
    }
    let date = new Date(markerData.createdAt);
    let time = pad(date.getHours()) + ':' + pad(date.getMinutes());

    jQuery('#legendTime').text(time);
    jQuery('#legendUser').text(markerData.userTitle);
    jQuery('#legendTitle').text(markerData.title);
    jQuery('#legendDescription').text(markerData.description);
    jQuery('#legend').show();

    jQuery('#legendTime').offset({
    	top: jQuery('#legend').offset().top + 25,
    	left: jQuery('#legendDescription').offset().left + jQuery('#legendDescription').width() - jQuery('#legendTime').width()
    });
    jQuery('#legendUser').offset({
    	top: jQuery('#legend').offset().top + 25,
    	left: jQuery('#legendDescription').offset().left
    });
    
    $("#legendUser")
    .prop('onclick', null)
    .off('click');
    
    $("#legendUser").click({
    	getUser(markerData.userId);
    });
}

function showUserDetails(user){
	// TODO
}

function pad(input) {
	let padding = '00';
	return (padding + input).slice(-padding.length);
}

function hideMarker() {
    jQuery('#legend').hide();
    var player = document.getElementById('kaltura_player_1497188473');
    if(player && player.sendNotification) {
        player.sendNotification('doStop');
    }
}

function add() {
    currentMarker.setVisible(false);
    var markerData = {
        position : {
            lat: parseFloat(jQuery('#lat').val()),
            lng: parseFloat(jQuery('#lng').val())
        },
        userId: userId,
        title: jQuery('#title').val(),
        description: jQuery('#description').val(),
        recordingId: jQuery('#recordingId').val()
    };

    jQuery.ajax({
            url: '/addMarker.json',
            dataType: 'json',
            type: 'POST',
            contentType : 'application/json',
            data: JSON.stringify(markerData),
            success: (markerData) => {
            addMarker(markerData);
}
});

    hideForm();
}

function getDeviceStream(option) {
    if ('getUserMedia' in navigator.mediaDevices) {
        return navigator.mediaDevices.getUserMedia(option);
    }
    else {
        return new Promise(function(resolve, reject){
            navigator.getUserMedia(option,
                resolve,
                reject
            );
        });
    }
}

function openVideo() {
    jQuery('#timer').text(60);
    jQuery('#videoControls').hide();
    jQuery('#videoDialog').show();
    jQuery('#openVideo').hide();
    getDeviceStream({video: true, audio: true})
        .then((stream) => { // success
        localStream = stream;
    playVideo(localVideo, stream);
    enableRecording();
}).catch(function (error) { // error
        console.error('getUserMedia error:', error);
    });
}

function playVideo(element, stream) {
    if ('srcObject' in element) {
        element.srcObject = stream;
    }
    else {
        element.src = window.URL.createObjectURL(stream);
    }
    element.play();
    element.volume = 0;
}

function hideForm(id) {
    if (!id){
        id="form";
    }
    jQuery('#'+id).hide();
    stop();
}

function dissconnect() {
    send('quit');

    if (peerConnection) {
        console.log('Quiting');
        peerConnection.close();
        peerConnection = null;
    }
    else {
        console.warn('Peer doesn\'t exist');
    }

    localVideo.pause();
    if (localVideo.src && (localVideo.src !== '') ) {
        window.URL.revokeObjectURL(localVideo.src);
    }

    stopLocalStream(localStream);
    localStream = null;
}

function stopLocalStream(stream) {
    let tracks = stream.getTracks();
    if (! tracks) {
        console.warn('NO tracks');
        return;
    }

    for (let track of tracks) {
        track.stop();
    }
}

function openActions(){
    if(!currentMarker) {
        return alert('חפש תחילה את הכתובת בה אתה נמצא');
    }
    $('#actions').show();
}

function openForm() {
    if(!currentMarker) {
        return alert('חפש תחילה את הכתובת בה אתה נמצא');
    }
    hideActions();
    jQuery('#videoDialog').hide();
    jQuery('#openVideo').show();
    jQuery('#recordingId').val('');
    jQuery('#lat').val(currentMarker.position.lat);
    jQuery('#lng').val(currentMarker.position.lng);
    jQuery('#title').val(jQuery('#search').val());
    jQuery('#description').val('');
    jQuery('#form').show();
}

function openUserForm(){
    $('#userForm').show();

}

function hideActions(){
    $('#actions').hide();

}

function showLoader(){
    $('#spinner').show();
}
function hideLoader(){
    $('#spinner').hide();
    updateHeight();
}
function updateHeight(){
    var totalHeight = $(window).height();
    $("#map").height(totalHeight - 150);
}

window.addEventListener("orientationchange", function() {
    updateHeight();
});
